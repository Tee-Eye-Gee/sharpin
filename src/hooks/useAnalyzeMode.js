import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Chess } from 'chess.js'
import { useStockfishEngine } from './useStockfishEngine'

// Placeholder testing depth only -- real mobile/desktop defaults are not
// yet on-device-verified (spec §3/§8) and will be tuned in a future pass.
// Do not treat this number as final.
const ANALYZE_DEPTH = 16

// Long PVs get unwieldy fast, especially at 375px -- truncate for legibility
// rather than trying to fit a 20-ply line into a sidebar.
const PV_DISPLAY_PLIES = 6

function sideToMoveIsBlack(fen) {
  return fen.split(' ')[1] === 'b'
}

// UCI's score is always from the side-to-move's perspective; flip it to a
// consistent White's-perspective sign (the standard chess-UI convention)
// so the number doesn't silently swap meaning depending on whose move it is.
function normalizeScore(scoreType, scoreValue, blackToMove) {
  if (scoreType == null || scoreValue == null) return { scoreType: null, scoreValue: null }
  return { scoreType, scoreValue: blackToMove ? -scoreValue : scoreValue }
}

// A positive SIDE-TO-MOVE-relative mate score means the analyzed position's
// mover delivers mate -- the best possible outcome, sorted above every eval
// line, regardless of color. This is deliberately NOT the same thing as
// line.scoreValue: normalizeScore above has already flipped that to a
// White's-perspective sign (correct for the advantage bar and mate badge,
// which are genuinely White-relative), so a mate BLACK delivers reads as a
// *negative* line.scoreValue even though it's a maximally winning result
// whenever Black is to move. Sorting on line.scoreValue's raw sign was the
// round-4 bug (a Black-delivered checkmate displayed "M-3" and sorted to
// the bottom, below positive eval lines) -- mateSortCategory takes the
// side-to-move-relative value explicitly so it can't silently reinterpret
// the wrong reference frame again.
// 0 = winning mate (best), 1 = eval line (middle), 2 = losing mate (worst).
function mateSortCategory(scoreType, sideToMoveValue) {
  if (scoreType !== 'mate') return 1
  return sideToMoveValue > 0 ? 0 : 2
}

// Category first (winning mates, then evals, then losing mates), both
// computed side-to-move-relative via blackToMove -- see mateSortCategory.
// Within the same mate category, ascending side-to-move-relative value is
// "better" both ways: for winning mates a smaller positive N is a faster
// win (M1 above M2); for losing mates a more negative value is the
// more-delayed, less-bad loss (M-3 above M-2) -- this only lines up with
// M1-above-M2/M-3-above-M-2 in side-to-move terms, not in line.scoreValue's
// White-relative terms, which is why the tie-break re-derives the same
// sideToMoveValue rather than falling back to a.scoreValue. Eval/eval pairs
// keep their original MultiPV-slot relative order -- returning 0 relies on
// sort's stability.
function compareLinesForDisplay(blackToMove) {
  return (a, b) => {
    const svA = blackToMove ? -a.scoreValue : a.scoreValue
    const svB = blackToMove ? -b.scoreValue : b.scoreValue
    const catA = mateSortCategory(a.scoreType, svA)
    const catB = mateSortCategory(b.scoreType, svB)
    if (catA !== catB) return catA - catB
    if (catA === 1) return 0
    return svA - svB
  }
}

// Converts a UCI pv (["e2e4", "e7e5", ...]) to SAN from a given position.
// Stops early (rather than throwing) if a move in the pv is somehow illegal
// in this exact position -- defensive against the info line's pv trailing
// off past a truncation point that doesn't quite line up.
function pvToSan(fen, pv) {
  const chess = new Chess(fen)
  const sans = []
  for (const uci of pv.slice(0, PV_DISPLAY_PLIES)) {
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    const promotion = uci.length > 4 ? uci[4] : undefined
    // chess.js v1's object-form move() throws (not returns null/undefined)
    // for an illegal move -- and a PV line computed for the PREVIOUS
    // position is briefly still in the engine snapshot for a moment after
    // the position changes (before the new search's first info line
    // lands), so replaying it here against the new `fen` is expected to
    // go illegal partway through. Stop gracefully rather than letting the
    // exception propagate out of a render-time useMemo, which would
    // unmount the whole tree with no error boundary to catch it.
    let result
    try {
      result = chess.move({ from, to, promotion })
    } catch {
      break
    }
    if (!result) break
    sans.push(result.san)
  }
  return { sans, truncated: pv.length > PV_DISPLAY_PLIES }
}

/**
 * Free-exploration analysis state for a single Analyze Mode session (spec
 * docs/specs/Sharpin_Spec_AnalyzeMode.md). Entirely local/ephemeral by
 * construction -- everything here is plain React state with no IndexedDB
 * access anywhere in this file, so unmounting the component that calls this
 * hook (Analyze mode's Exit) discards the whole exploration for free, per
 * spec §5.
 *
 * History is linear FEN+lastMove snapshots with standard undo/redo
 * semantics: playing a move past the current point truncates any "redo"
 * tail (spec §4.4 back/forward).
 */
export function useAnalyzeMode(startFen) {
  const engine = useStockfishEngine({ multiPv: 3 })

  const [history, setHistory] = useState(() => [{ fen: startFen, lastMove: null }])
  const [currentIndex, setCurrentIndex] = useState(0)
  const current = history[currentIndex]
  const currentFen = current.fen

  // rAF-batched read of the engine's external store (locked render-batching
  // pattern) -- stockfishClient's subscribe/getSnapshot is deliberately
  // un-wired to React state by useStockfishEngine so this layer decides the
  // flush cadence, rather than re-rendering on every raw `info` line.
  const [snapshot, setSnapshot] = useState(() => engine.getSnapshot())
  const rafRef = useRef(null)
  // Deliberately depend on the individual functions (engine.subscribe,
  // engine.getSnapshot), not the `engine` object itself -- useStockfishEngine
  // returns a fresh object literal every render, so depending on the whole
  // object would re-run this effect (unsubscribe/resubscribe) on every
  // render instead of only on real changes. The functions themselves are
  // useCallback-stabilized with empty deps, so they're safe to depend on.
  useEffect(() => {
    const flush = () => {
      rafRef.current = null
      setSnapshot(engine.getSnapshot())
    }
    const unsubscribe = engine.subscribe(() => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush)
    })
    return () => {
      unsubscribe()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [engine.subscribe, engine.getSnapshot])

  // Fires on mount and on every explored-position change (a played move or
  // a Back/Forward step). search() itself implements the full locked
  // cancel sequence (generation bump -> stop -> wait for terminal bestmove
  // -> new position+go) -- this only triggers it, never reimplements it.
  // Same stable-function-reference reasoning as above: depend on
  // engine.search, not `engine`, so this only re-fires when currentFen
  // actually changes, not on every unrelated re-render.
  useEffect(() => {
    engine.search({ fen: currentFen, moves: [], depth: ANALYZE_DEPTH })
  }, [engine.search, currentFen])

  const onUserMove = useCallback((from, to, piece) => {
    const chess = new Chess(currentFen)
    const promotion = piece && piece.length > 1 ? piece[1].toLowerCase() : undefined
    const result = chess.move({ from, to, promotion })
    if (!result) return false

    setHistory((prev) => [
      ...prev.slice(0, currentIndex + 1),
      { fen: chess.fen(), lastMove: { from: result.from, to: result.to } },
    ])
    setCurrentIndex((i) => i + 1)
    return true
  }, [currentFen, currentIndex])

  const canGoBack = currentIndex > 0
  const canGoForward = currentIndex < history.length - 1
  const goBack = useCallback(() => setCurrentIndex((i) => Math.max(0, i - 1)), [])
  const goForward = useCallback(() => setCurrentIndex((i) => Math.min(history.length - 1, i + 1)), [history.length])

  const lines = useMemo(() => {
    const blackToMove = sideToMoveIsBlack(currentFen)
    const mapped = snapshot.lines.map((line) => {
      const { sans, truncated } = pvToSan(currentFen, line.pv)
      const { scoreType, scoreValue } = normalizeScore(line.scoreType, line.scoreValue, blackToMove)
      return { multipv: line.multipv, scoreType, scoreValue, sans, truncated }
    })
    // Display order only -- deliberately separate from `topScore`/
    // `bestMoveArrow` below, which stay pinned to the true PV1 slot
    // regardless of how the list is displayed (arrow always represents
    // PV1 only, unchanged from the prior pass).
    return mapped.slice().sort(compareLinesForDisplay(blackToMove))
  }, [snapshot.lines, currentFen])

  const pv1 = snapshot.lines.find((l) => l.multipv === 1)
  const bestMoveArrow = pv1 && pv1.pv[0] ? { from: pv1.pv[0].slice(0, 2), to: pv1.pv[0].slice(2, 4) } : null
  // Normalized (White's-perspective) PV1 score, exposed separately from
  // `lines` so consumers driven by "the current top-line verdict" (the
  // board's mate tag, the advantage bar) read the same authoritative value
  // the arrow does, rather than re-deriving it from the display-sorted list.
  const topScore = pv1
    ? normalizeScore(pv1.scoreType, pv1.scoreValue, sideToMoveIsBlack(currentFen))
    : { scoreType: null, scoreValue: null }

  return {
    fen: currentFen,
    lastMove: current.lastMove,
    lines,
    depth: snapshot.depth,
    searching: snapshot.searching,
    bestMoveArrow,
    topScore,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    onUserMove,
  }
}
