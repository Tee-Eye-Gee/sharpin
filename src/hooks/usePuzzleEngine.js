import { useState, useCallback, useRef, useEffect } from 'react'
import { Chess } from 'chess.js'
import { nearestBands, bandForRating, updateRating } from '../utils/rating'
import { getActiveIdentity, getProfile, recordAttempt, getRecentAttempts, getAllAttempts } from '../utils/storage'
import { generateCoachNote } from '../utils/coach'

// Vite code-splits each of these into its own lazily-fetched, content-hashed
// chunk — only the rating band(s) actually needed get downloaded, and the
// browser caches them for free on repeat visits.
const puzzleModules = import.meta.glob('../data/puzzles/*.json')

async function loadBand(file) {
  const loader = puzzleModules[`../data/puzzles/${file}`]
  if (!loader) return []
  const mod = await loader()
  return mod.default ?? mod
}

// Weighted random pick that favors puzzles whose themes the user hasn't
// seen recently, and skips puzzle ids already attempted in the window.
function pickWeighted(candidates, recentThemeCounts, excludeIds) {
  const pool = candidates.filter((p) => !excludeIds.has(p.id))
  if (pool.length === 0) return null

  const weights = pool.map((p) => {
    const overlap = p.themes.reduce((sum, t) => sum + (recentThemeCounts[t] || 0), 0)
    return 1 / (1 + overlap)
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i]
    if (r <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}

function uciToMove(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  }
}

const RECENT_WINDOW = 25 // attempts of lookback for theme-variety weighting + no-repeat

/**
 * @param {object} [options]
 * @param {string|null} [options.readyIdentity] - Backlog #1d readiness gate,
 *   supplied by App.jsx: the identity whose local profile is ready to drive
 *   puzzle selection and rating math, or null while none is (boot still
 *   adopting legacy data, or a signed-in account's stats pull still
 *   pending). Puzzles load only for this identity; when it changes, the
 *   current puzzle is discarded and a fresh one loads from the new
 *   identity's band once it's ready. Omitting `options` entirely keeps the
 *   original ungated behavior (load at mount, identity resolved live) --
 *   only isolated hook harnesses rely on that; App.jsx always passes it.
 */
export function usePuzzleEngine({ readyIdentity } = {}) {
  const gated = readyIdentity !== undefined
  // Mirrored into refs during render, not in an effect, so a commit that
  // races a user change sees the new value immediately.
  const gatedRef = useRef(gated)
  gatedRef.current = gated
  const readyIdentityRef = useRef(readyIdentity)
  readyIdentityRef.current = readyIdentity
  // The identity the current puzzle was loaded for. Every profile read and
  // attempt write for this puzzle is pinned to it, never re-resolved.
  const puzzleIdentityRef = useRef(null)
  // Bumped by every load and every discard. Async work captures it and
  // drops its UI updates if it changed underneath (a stale load can't
  // install its puzzle over a newer one, a stale finish can't overwrite
  // the next puzzle's status).
  const loadGenRef = useRef(0)
  const chessRef = useRef(new Chess())
  const puzzleRef = useRef(null)
  const plyRef = useRef(0)
  const startTimeRef = useRef(null)
  // Sole commit guard: true once commitAttempt has written for this puzzle
  // instance. Reset only in loadPuzzle, so no path (wrong move, hint press,
  // or a post-retry move) can ever produce a second write for the same
  // puzzle.
  const attemptCommittedRef = useRef(false)
  // Mirrors hintUsedThisAttempt state for synchronous reads inside
  // commitAttempt, which is a stable (empty-deps) callback and would
  // otherwise close over a stale value. Same lifecycle as
  // hintUsedThisAttempt: set together, reset only in loadPuzzle.
  const hintUsedRef = useRef(false)
  // Distinct from attemptCommittedRef: true from the moment the user makes
  // their first real move attempt or hint press against the CURRENT puzzle
  // instance, whether or not that interaction itself triggers a commit.
  // Investigated during Sub-build B2a's gating-deadlock fix: no existing
  // signal (attemptCommittedRef, hintUsedRef, isRetrying) captures this --
  // all three either only flip at/after commit time, or (isRetrying) are
  // only reachable once a commit has already happened. The gap this closes
  // is real: on a multi-move puzzle, a correct-but-not-final move leaves
  // the attempt genuinely "started, not yet committed" for however many
  // moves remain (finishAttempt/commitAttempt only fire on the final move
  // or a wrong move), which none of the other refs distinguish from a
  // freshly-loaded, zero-interaction puzzle. Mirrored by attemptStarted
  // state below for reactive consumers (e.g. App.jsx's launch-overlay
  // gating) -- same pattern as hintUsedRef/hintUsedThisAttempt. Reset only
  // in loadPuzzle, same lifecycle as attemptCommittedRef/hintUsedRef.
  const attemptStartedRef = useRef(false)

  const [fen, setFen] = useState(null)
  // The position where solving begins (post opponent-setup-move) -- fixed
  // for the whole puzzle instance, unlike `fen` which advances with every
  // move. Analyze mode's entry point per spec §2 ("starting FEN, not final
  // position"); survives retries since retryPuzzle rebuilds this exact
  // position without touching this value.
  const [puzzleStartFen, setPuzzleStartFen] = useState(null)
  const [orientation, setOrientation] = useState('white')
  const [status, setStatus] = useState('loading') // loading | solving | correct | solved | failed
  const [userRating, setUserRating] = useState(null)
  const [lastDelta, setLastDelta] = useState(0)
  const [streak, setStreak] = useState(0)
  const [currentThemes, setCurrentThemes] = useState([])
  const [puzzleRating, setPuzzleRating] = useState(null)
  const [coachNote, setCoachNote] = useState('')
  const [lastMove, setLastMove] = useState(null)
  // Plain UI-state flag — not a counter. True from the moment the user first
  // clicks Retry until the next loadPuzzle. Lets the board go interactive
  // again post-fail without re-arming the commit path (finishAttempt is
  // gated separately, above).
  const [isRetrying, setIsRetrying] = useState(false)
  // 0 = not pressed for the current move, 1 = piece highlighted, 2 = piece +
  // destination highlighted. Re-armed to 0 every time plyRef advances (see
  // onUserMove) — never touches attemptCommittedRef.
  const [hintTier, setHintTier] = useState(0)
  // Attempt-scoped (puzzle-instance-scoped), not retry-scoped: true the
  // moment hint is first pressed anywhere in this puzzle instance's
  // lifetime, including across retries. Reset only in loadPuzzle, same
  // lifecycle as attemptCommittedRef — deliberately NOT reset by
  // retryPuzzle (spec §9: hint-then-solve on any retry still reads
  // "Solved - hint used").
  const [hintUsedThisAttempt, setHintUsedThisAttempt] = useState(false)
  // Reactive twin of attemptStartedRef -- see that ref's comment for what
  // this does and doesn't mean. Consumed by App.jsx to gate the launch
  // overlay's Create Account/Login on genuine in-flight interaction, not
  // merely "a puzzle is loaded."
  const [attemptStarted, setAttemptStarted] = useState(false)

  const advanceOpponentMove = useCallback(() => {
    const puzzle = puzzleRef.current
    const chess = chessRef.current
    const nextUci = puzzle.moves[plyRef.current]
    if (!nextUci) return
    const result = chess.move(uciToMove(nextUci))
    plyRef.current += 1
    if (result) {
      setFen(chess.fen())
      setLastMove({ from: result.from, to: result.to })
    }
  }, [])

  const loadPuzzle = useCallback(async () => {
    const gen = ++loadGenRef.current
    setStatus('loading')
    setCoachNote('')

    const identity = gatedRef.current ? readyIdentityRef.current : await getActiveIdentity()
    // Not ready: stay in 'loading'. The readiness effect below loads once it is.
    if (identity == null || gen !== loadGenRef.current) return

    const profile = await getProfile({ identity })
    if (gen !== loadGenRef.current) return
    setUserRating(profile.rating)
    setStreak(profile.currentStreak)

    const recent = await getRecentAttempts(RECENT_WINDOW, { identity })
    if (gen !== loadGenRef.current) return
    const excludeIds = new Set(recent.map((a) => a.puzzleId))
    const recentThemeCounts = {}
    for (const a of recent) {
      for (const t of a.themes ?? []) recentThemeCounts[t] = (recentThemeCounts[t] || 0) + 1
    }

    let chosen = null
    for (const band of nearestBands(profile.rating)) {
      const puzzles = await loadBand(band.file)
      if (gen !== loadGenRef.current) return
      chosen = pickWeighted(puzzles, recentThemeCounts, excludeIds)
      if (chosen) break
    }
    if (!chosen) {
      // Small-dataset edge case (extreme ratings) — retry the home band
      // ignoring the no-repeat window rather than leaving the user stuck.
      const puzzles = await loadBand(bandForRating(profile.rating).file)
      if (gen !== loadGenRef.current) return
      chosen = pickWeighted(puzzles, recentThemeCounts, new Set())
    }
    if (!chosen) {
      setStatus('error')
      return
    }

    const chess = new Chess(chosen.fen)
    chessRef.current = chess
    puzzleRef.current = chosen
    puzzleIdentityRef.current = identity
    attemptCommittedRef.current = false
    hintUsedRef.current = false
    attemptStartedRef.current = false
    setIsRetrying(false)
    setHintTier(0)
    setHintUsedThisAttempt(false)
    setAttemptStarted(false)
    setLastMove(null)

    // The stored FEN is the position before the opponent's setup move
    // (moves[0]); apply it so the board opens where the solver must respond.
    const setupUci = chosen.moves[0]
    plyRef.current = 0
    if (setupUci) {
      chess.move(uciToMove(setupUci))
      plyRef.current = 1
    }

    setOrientation(chess.turn() === 'w' ? 'white' : 'black')
    setCurrentThemes(chosen.themes)
    setPuzzleRating(chosen.rating)
    setFen(chess.fen())
    setPuzzleStartFen(chess.fen())
    setLastDelta(0)
    startTimeRef.current = Date.now()
    setStatus('solving')
  }, [])

  // Write + coach-note portion only — no status transition. Fires exactly
  // once per attempt instance, gated by attemptCommittedRef, regardless of
  // what triggers it (a hint tier-1 press or a move-driven puzzle-finish).
  // Coach note is generated here (at commit time), not deferred to
  // puzzle-finish, so a hint-then-abandon (Next Puzzle without finishing)
  // still surfaces it — see docs/specs/Sharpin_Spec_HintSystem.md §10a.
  const commitAttempt = useCallback(async (solved) => {
    // Synchronous, pre-await: closes off the same-tick re-entrancy window
    // (see usePuzzleEngine.js commit-guard note) as well as any post-retry
    // call — this is the single point every commit path must clear.
    if (attemptCommittedRef.current) return
    attemptCommittedRef.current = true

    const puzzle = puzzleRef.current
    const identity = puzzleIdentityRef.current
    // Captured before any await: a discard mid-commit resets the ref.
    const hintUsed = hintUsedRef.current

    // Backlog #1d commit guard. The rating delta must come from the profile
    // of the identity this puzzle was loaded for, read once that identity's
    // profile is ready -- never another identity's profile, and never a
    // DEFAULT_PROFILE standing in while an account's stats pull is still
    // pending (App.jsx holds readyIdentity at null until it lands). If any
    // of that doesn't hold, write nothing: the attempt is abandoned, which
    // is recoverable, while a wrong delta folds permanently into the
    // server's summed rating. attemptCommittedRef stays true, so this
    // puzzle instance can never commit later either.
    if (!puzzle || identity == null) return
    if (gatedRef.current && readyIdentityRef.current !== identity) return
    if ((await getActiveIdentity()) !== identity) return
    if (puzzleIdentityRef.current !== identity) return // discarded during that await

    // Both calls pinned to `identity`: if the session changes after the
    // guard above, the attempt still lands under the user who played it,
    // with that user's delta (and #1e's push guard keeps it off the other
    // account's server rows).
    const profile = await getProfile({ identity })
    const { newRating, delta } = updateRating(profile.rating, puzzle.rating, solved)
    const timeTakenMs = Date.now() - startTimeRef.current

    const updatedProfile = await recordAttempt({
      puzzleId: puzzle.id,
      themes: puzzle.themes,
      solved,
      hintUsed,
      newRating,
      ratingDelta: delta,
      timeTakenMs,
      identity,
    })

    // The write above is correct regardless; only the display updates are
    // skipped if the user changed while it ran.
    if (puzzleIdentityRef.current !== identity) return
    setUserRating(updatedProfile.rating)
    setLastDelta(delta)
    setStreak(updatedProfile.currentStreak)

    // Rule-based, fully local — no network call, no API key. Reads the
    // attempt log this same recordAttempt() call just wrote to.
    const attempts = await getAllAttempts({ identity })
    if (puzzleIdentityRef.current !== identity) return
    setCoachNote(generateCoachNote({ themes: puzzle.themes, solved, profile: updatedProfile, attempts }))
  }, [])

  // Status-transition portion — invoked only at actual puzzle-finish (wrong
  // move, or completed correct sequence). Always reflects the real move
  // outcome, independent of whatever commitAttempt already wrote: a puzzle
  // can score-fail via an earlier hint press and still finish 'solved' here
  // (spec §4) — commitAttempt no-ops in that case (already committed), but
  // the status shown to the user tracks the actual finish, not the write.
  const finishAttempt = useCallback(async (solved) => {
    const gen = loadGenRef.current
    await commitAttempt(solved)
    if (gen !== loadGenRef.current) return // puzzle discarded or replaced meanwhile
    setStatus(solved ? 'solved' : 'failed')
  }, [commitAttempt])

  const onUserMove = useCallback((sourceSquare, targetSquare, piece) => {
    if (status !== 'solving') return false
    const puzzle = puzzleRef.current
    const chess = chessRef.current
    const expectedUci = puzzle.moves[plyRef.current]
    if (!expectedUci) return false

    // A real move attempt against the current puzzle is being processed --
    // mark interaction as started (see attemptStartedRef's comment). Set
    // before the right/wrong branch below, since both branches count.
    if (!attemptStartedRef.current) {
      attemptStartedRef.current = true
      setAttemptStarted(true)
    }

    // react-chessboard's default promotion dialog (shown whenever a pawn
    // drops on the back rank) reports the piece the player actually chose
    // via this `piece` arg (e.g. "wN") — read the underpromotion straight
    // from that instead of assuming queen. Only consulted when the
    // solution itself is a promotion; a plain move's `piece` is just the
    // dragged piece's type and isn't a promotion signal.
    const promotion = expectedUci.length > 4 && piece ? piece[1].toLowerCase() : ''
    const attemptedUci = sourceSquare + targetSquare + promotion

    if (attemptedUci !== expectedUci) {
      if (isRetrying) {
        // Outcome already fixed at the original fail — reuse the same
        // "Not Quite" UI (status-driven ring/headline/CoachNote), no write.
        setStatus('failed')
      } else {
        finishAttempt(false)
      }
      return false
    }

    const result = chess.move(uciToMove(expectedUci))
    if (!result) return false

    plyRef.current += 1
    setHintTier(0) // re-arm tier 1 for the new current move
    setFen(chess.fen())
    setLastMove({ from: result.from, to: result.to })

    if (plyRef.current >= puzzle.moves.length) {
      if (isRetrying) {
        // Practice solve after an already-committed fail — board shows the
        // solved state for the user's benefit, but no write.
        setStatus('solved')
      } else {
        finishAttempt(true)
      }
      return true
    }

    setStatus('correct')
    const gen = loadGenRef.current
    setTimeout(() => {
      if (gen !== loadGenRef.current) return
      advanceOpponentMove()
      setStatus('solving')
    }, 400)
    return true
  }, [status, isRetrying, finishAttempt, advanceOpponentMove])

  // Tier 1 on first press for the current move, tier 2 on the second —
  // capped there until the next move re-arms it (see the onUserMove reset
  // above). First press of the whole puzzle instance commits the
  // scoring-fail write immediately (commitAttempt is itself idempotent past
  // that point, so later presses on later moves are safe no-ops write-wise)
  // but never touches status — board stays interactive through to actual
  // puzzle-finish, per spec §4.
  const pressHint = useCallback(() => {
    if (status !== 'solving') return
    if (!attemptStartedRef.current) {
      attemptStartedRef.current = true
      setAttemptStarted(true)
    }
    setHintTier((prev) => {
      if (prev === 0) {
        hintUsedRef.current = true
        setHintUsedThisAttempt(true)
        // Explicit skip, mirroring onUserMove's own isRetrying branch —
        // structurally redundant with the ref-guard in commitAttempt
        // (isRetrying can only be true once attemptCommittedRef already
        // is), but kept explicit for readability/symmetry per the Aug 7
        // investigation's item 5 resolution.
        if (!isRetrying) commitAttempt(false)
      }
      return Math.min(prev + 1, 2)
    })
  }, [status, isRetrying, commitAttempt])

  // Purely presentational: puts the board back at the puzzle's start
  // position (same derivation as loadPuzzle's setup-move handling) so the
  // user can attempt again. The outcome (solved or failed) was already
  // fixed at the original commit, so this never touches storage.
  const retryPuzzle = useCallback(() => {
    const puzzle = puzzleRef.current
    if (!puzzle || (status !== 'failed' && status !== 'solved')) return

    const chess = new Chess(puzzle.fen)
    chessRef.current = chess
    plyRef.current = 0
    const setupUci = puzzle.moves[0]
    if (setupUci) {
      chess.move(uciToMove(setupUci))
      plyRef.current = 1
    }

    setLastMove(null)
    setFen(chess.fen())
    setIsRetrying(true)
    setHintTier(0) // note: hintUsedThisAttempt deliberately survives the retry
    setStatus('solving')
  }, [status])

  // Drops the current puzzle without committing anything -- used when the
  // active identity changes or stops being ready (Backlog #1d). The board
  // goes back to 'loading' with nothing on it until the next load.
  const discardPuzzle = useCallback(() => {
    loadGenRef.current += 1
    puzzleRef.current = null
    puzzleIdentityRef.current = null
    attemptCommittedRef.current = true
    hintUsedRef.current = false
    attemptStartedRef.current = false
    setStatus('loading')
    setFen(null)
    setPuzzleStartFen(null)
    setUserRating(null)
    setLastDelta(0)
    setStreak(0)
    setCurrentThemes([])
    setPuzzleRating(null)
    setCoachNote('')
    setLastMove(null)
    setIsRetrying(false)
    setHintTier(0)
    setHintUsedThisAttempt(false)
    setAttemptStarted(false)
  }, [])

  // Ungated (no options passed): original behavior, load once at mount.
  useEffect(() => {
    if (!gated) loadPuzzle()
  }, [gated, loadPuzzle])

  // Gated: load only for a ready identity. Covers boot (#1d proper: no
  // load until App's adoption step has finished) and every user change
  // (login, logout, a session restored on page load) -- the outgoing
  // user's puzzle is discarded, and the incoming user's puzzle is chosen
  // from their own profile only once it's ready.
  useEffect(() => {
    if (!gated) return
    if (readyIdentity == null) {
      discardPuzzle()
      return
    }
    if (puzzleIdentityRef.current === readyIdentity) return
    discardPuzzle()
    loadPuzzle()
  }, [gated, readyIdentity, discardPuzzle, loadPuzzle])

  // Derived display-only squares for the current tier — recomputed each
  // render from the refs, not stored separately, since hintTier is the only
  // thing that needs to be reactive here.
  const currentExpectedUci = puzzleRef.current?.moves?.[plyRef.current]
  const hintPieceSquare = hintTier >= 1 && currentExpectedUci ? currentExpectedUci.slice(0, 2) : null
  const hintDestSquare = hintTier >= 2 && currentExpectedUci ? currentExpectedUci.slice(2, 4) : null

  return {
    fen,
    puzzleStartFen,
    orientation,
    status,
    userRating,
    lastDelta,
    streak,
    currentThemes,
    puzzleRating,
    coachNote,
    lastMove,
    isRetrying,
    hintPieceSquare,
    hintDestSquare,
    hintUsedThisAttempt,
    attemptStarted,
    onUserMove,
    loadNextPuzzle: loadPuzzle,
    pressHint,
    retryPuzzle,
  }
}
