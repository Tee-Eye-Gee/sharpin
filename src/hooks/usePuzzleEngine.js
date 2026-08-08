import { useState, useCallback, useRef, useEffect } from 'react'
import { Chess } from 'chess.js'
import { nearestBands, bandForRating, updateRating } from '../utils/rating'
import { getProfile, recordAttempt, getRecentAttempts, getAllAttempts } from '../utils/storage'
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

export function usePuzzleEngine() {
  const chessRef = useRef(new Chess())
  const puzzleRef = useRef(null)
  const plyRef = useRef(0)
  const startTimeRef = useRef(null)
  // Sole commit guard: true once commitAttempt has written for this puzzle
  // instance. Reset only in loadPuzzle, so no path (wrong move, hint press,
  // or a post-retry move) can ever produce a second write for the same
  // puzzle.
  const attemptCommittedRef = useRef(false)

  const [fen, setFen] = useState(null)
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
    setStatus('loading')
    setCoachNote('')

    const profile = await getProfile()
    setUserRating(profile.rating)

    const recent = await getRecentAttempts(RECENT_WINDOW)
    const excludeIds = new Set(recent.map((a) => a.puzzleId))
    const recentThemeCounts = {}
    for (const a of recent) {
      for (const t of a.themes ?? []) recentThemeCounts[t] = (recentThemeCounts[t] || 0) + 1
    }

    let chosen = null
    for (const band of nearestBands(profile.rating)) {
      const puzzles = await loadBand(band.file)
      chosen = pickWeighted(puzzles, recentThemeCounts, excludeIds)
      if (chosen) break
    }
    if (!chosen) {
      // Small-dataset edge case (extreme ratings) — retry the home band
      // ignoring the no-repeat window rather than leaving the user stuck.
      const puzzles = await loadBand(bandForRating(profile.rating).file)
      chosen = pickWeighted(puzzles, recentThemeCounts, new Set())
    }
    if (!chosen) {
      setStatus('error')
      return
    }

    const chess = new Chess(chosen.fen)
    chessRef.current = chess
    puzzleRef.current = chosen
    attemptCommittedRef.current = false
    setIsRetrying(false)
    setHintTier(0)
    setHintUsedThisAttempt(false)
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
    const profile = await getProfile()
    const { newRating, delta } = updateRating(profile.rating, puzzle.rating, solved)
    const timeTakenMs = Date.now() - startTimeRef.current

    const updatedProfile = await recordAttempt({
      puzzleId: puzzle.id,
      themes: puzzle.themes,
      solved,
      newRating,
      ratingDelta: delta,
      timeTakenMs,
    })

    setUserRating(updatedProfile.rating)
    setLastDelta(delta)
    setStreak(updatedProfile.currentStreak)

    // Rule-based, fully local — no network call, no API key. Reads the
    // attempt log this same recordAttempt() call just wrote to.
    const attempts = await getAllAttempts()
    setCoachNote(generateCoachNote({ themes: puzzle.themes, solved, profile: updatedProfile, attempts }))
  }, [])

  // Status-transition portion — invoked only at actual puzzle-finish (wrong
  // move, or completed correct sequence). Always reflects the real move
  // outcome, independent of whatever commitAttempt already wrote: a puzzle
  // can score-fail via an earlier hint press and still finish 'solved' here
  // (spec §4) — commitAttempt no-ops in that case (already committed), but
  // the status shown to the user tracks the actual finish, not the write.
  const finishAttempt = useCallback(async (solved) => {
    await commitAttempt(solved)
    setStatus(solved ? 'solved' : 'failed')
  }, [commitAttempt])

  const onUserMove = useCallback((sourceSquare, targetSquare, piece) => {
    if (status !== 'solving') return false
    const puzzle = puzzleRef.current
    const chess = chessRef.current
    const expectedUci = puzzle.moves[plyRef.current]
    if (!expectedUci) return false

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
    setTimeout(() => {
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
    setHintTier((prev) => {
      if (prev === 0) {
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

  useEffect(() => { loadPuzzle() }, [loadPuzzle])

  // Derived display-only squares for the current tier — recomputed each
  // render from the refs, not stored separately, since hintTier is the only
  // thing that needs to be reactive here.
  const currentExpectedUci = puzzleRef.current?.moves?.[plyRef.current]
  const hintPieceSquare = hintTier >= 1 && currentExpectedUci ? currentExpectedUci.slice(0, 2) : null
  const hintDestSquare = hintTier >= 2 && currentExpectedUci ? currentExpectedUci.slice(2, 4) : null

  return {
    fen,
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
    onUserMove,
    loadNextPuzzle: loadPuzzle,
    pressHint,
    retryPuzzle,
  }
}
