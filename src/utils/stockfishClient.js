const ENGINE_WORKER_URL = '/engine/stockfish-18-lite-single.js'

// Parses a UCI `info ... multipv N ...` line into a plain candidate-line
// record. Lines without both `depth` and `multipv` aren't a candidate-line
// update (e.g. `info string ...`) and are ignored by the caller.
function parseInfoLine(line) {
  const depthMatch = line.match(/\bdepth (\d+)/)
  const multipvMatch = line.match(/\bmultipv (\d+)/)
  if (!depthMatch || !multipvMatch) return null

  const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/)
  const pvMatch = line.match(/\bpv (.+)$/)

  return {
    depth: Number(depthMatch[1]),
    multipv: Number(multipvMatch[1]),
    scoreType: scoreMatch ? scoreMatch[1] : null, // 'cp' | 'mate' | null
    scoreValue: scoreMatch ? Number(scoreMatch[2]) : null,
    pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : [],
  }
}

function buildPositionCommand(fen, moves) {
  return moves && moves.length > 0
    ? `position fen ${fen} moves ${moves.join(' ')}`
    : `position fen ${fen}`
}

/**
 * Framework-agnostic Stockfish client: owns the Worker lifecycle, the UCI
 * handshake, and the generation-guarded cancel/replace sequence for
 * "user requests a new position while a search is in-flight" (see
 * docs/specs/Sharpin_Spec_AnalyzeMode.md §3 and the Aug 10 investigation's
 * stop/readyok timing findings). No React dependency, so it's usable
 * directly in tests -- src/hooks/useStockfishEngine.js is a thin wrapper.
 *
 * Push+pull external-store shape (subscribe/getSnapshot) rather than an
 * event-per-line callback: `getSnapshot()` always returns the latest
 * accumulated value per MultiPV slot for the current generation, cached
 * until the next real change, so a consumer (React or otherwise) can read
 * it as often or as rarely as it wants -- e.g. Stage 2 wiring this to a
 * requestAnimationFrame-throttled flush -- without this module needing to
 * know anything about render timing.
 */
export function createStockfishClient({ multiPv = 3 } = {}) {
  let worker = null
  let readyPromise = null

  // Generation is bumped synchronously on every search() call, independent
  // of Worker/engine state. It's the sole source of truth for "is this
  // message current" -- UCI itself carries no per-search id, so staleness
  // is entirely a JS-side attribution, not something read off the wire.
  let generation = 0
  let currentSearchGeneration = null

  // 'idle' | 'searching' | 'stopping'. 'stopping' covers the whole
  // stop-sent-but-terminal-bestmove-not-yet-seen window -- the ~20-30ms
  // tail where stale `info` lines were observed arriving even after
  // `readyok`, per the investigation. Only `bestmove` clears it.
  let engineState = 'idle'
  let pendingRequest = null // the request to launch once the in-flight stop's bestmove lands

  const lines = new Map() // multipv slot -> latest parsed info, current generation only
  let currentDepth = 0
  let searching = false

  const listeners = new Set()
  let cachedSnapshot = null
  let dirty = true

  function markDirty() {
    dirty = true
    for (const listener of listeners) listener()
  }

  function resetLines() {
    lines.clear()
    currentDepth = 0
  }

  function ensureWorker() {
    if (readyPromise) return readyPromise
    readyPromise = new Promise((resolve, reject) => {
      worker = new Worker(ENGINE_WORKER_URL)
      worker.onerror = (e) => reject(new Error(e.message || 'stockfish worker failed to load'))

      // Handshake-only listener, swapped out for handleEngineMessage once
      // setup completes -- keeps the steady-state handler free of init
      // branches.
      function onHandshakeMessage(e) {
        const line = typeof e.data === 'string' ? e.data : ''
        if (line === 'uciok') {
          worker.postMessage(`setoption name MultiPV value ${multiPv}`)
          worker.postMessage('isready')
        } else if (line.startsWith('readyok')) {
          worker.removeEventListener('message', onHandshakeMessage)
          worker.addEventListener('message', handleEngineMessage)
          resolve()
        }
      }
      worker.addEventListener('message', onHandshakeMessage)
      worker.postMessage('uci')
    })
    return readyPromise
  }

  function handleEngineMessage(e) {
    const line = typeof e.data === 'string' ? e.data : ''

    if (line.startsWith('info') && line.includes('multipv')) {
      // Stale-generation guard (locked step 4): drop unless this message
      // belongs to the generation actually running in the engine right now.
      if (currentSearchGeneration !== generation) return
      const parsed = parseInfoLine(line)
      if (!parsed) return
      lines.set(parsed.multipv, parsed)
      currentDepth = Math.max(currentDepth, parsed.depth)
      markDirty()
      return
    }

    if (line.startsWith('bestmove')) {
      if (engineState === 'stopping') {
        // Terminal ack of our `stop` (locked step 3) -- the engine is now
        // provably idle. Safe to launch whatever the latest requested
        // position is, superseding anything requested mid-stop.
        engineState = 'idle'
        searching = false
        const next = pendingRequest
        pendingRequest = null
        if (next) {
          launchSearch(next)
        } else {
          markDirty()
        }
        return
      }
      if (engineState === 'searching' && currentSearchGeneration === generation) {
        // Natural completion -- the engine reached the requested depth on
        // its own, nothing superseded it.
        engineState = 'idle'
        searching = false
        markDirty()
      }
      // Any other bestmove (stale generation, already-idle) is a leftover
      // we're not tracking a pending action for -- ignore it.
    }
  }

  function launchSearch(request) {
    currentSearchGeneration = request.gen
    resetLines()
    searching = true
    engineState = 'searching'
    worker.postMessage(buildPositionCommand(request.fen, request.moves))
    worker.postMessage(`go depth ${request.depth}`)
    markDirty()
  }

  /**
   * Request analysis of a position. Safe to call while a previous search is
   * still in-flight -- implements the locked 5-step cancel sequence:
   *   1. bump generation immediately (this call)
   *   2. send `stop` if a search is currently running
   *   3. wait for the terminal `bestmove` (not `readyok`)
   *   4. any `info`/`bestmove` seen before that point is dropped by
   *      handleEngineMessage's generation check
   *   5. only then send the new `position` + `go`
   * Rapid repeated calls while already 'stopping' don't send additional
   * `stop`s -- they just replace pendingRequest, so only the latest
   * request survives to be launched.
   */
  async function search({ fen, moves = [], depth }) {
    generation += 1
    const gen = generation
    const request = { fen, moves, depth, gen }

    await ensureWorker()
    // Another search() may have superseded this one while the worker was
    // still starting up -- if so, this call has nothing left to do.
    if (gen !== generation) return

    if (engineState === 'idle') {
      launchSearch(request)
    } else if (engineState === 'searching') {
      engineState = 'stopping'
      pendingRequest = request
      worker.postMessage('stop')
    } else {
      // Already 'stopping' -- a stop is already in flight; just swap in the
      // latest request for when its bestmove arrives.
      pendingRequest = request
    }
  }

  function getSnapshot() {
    if (dirty || !cachedSnapshot) {
      cachedSnapshot = {
        generation,
        depth: currentDepth,
        searching,
        lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv),
      }
      dirty = false
    }
    return cachedSnapshot
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function terminate() {
    generation += 1 // orphan any in-flight request/messages
    if (worker) {
      worker.terminate()
      worker = null
    }
    readyPromise = null
    engineState = 'idle'
    searching = false
    pendingRequest = null
    currentSearchGeneration = null
    resetLines()
    listeners.clear()
    dirty = true
  }

  return { search, getSnapshot, subscribe, terminate }
}
