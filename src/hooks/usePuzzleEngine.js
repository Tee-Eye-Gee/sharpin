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

  const finishAttempt = useCallback(async (solved) => {
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
    setStatus(solved ? 'solved' : 'failed')

    // Rule-based, fully local — no network call, no API key. Reads the
    // attempt log this same recordAttempt() call just wrote to.
    const attempts = await getAllAttempts()
    setCoachNote(generateCoachNote({ themes: puzzle.themes, solved, profile: updatedProfile, attempts }))
  }, [])

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
      finishAttempt(false)
      return false
    }

    const result = chess.move(uciToMove(expectedUci))
    if (!result) return false

    plyRef.current += 1
    setFen(chess.fen())
    setLastMove({ from: result.from, to: result.to })

    if (plyRef.current >= puzzle.moves.length) {
      finishAttempt(true)
      return true
    }

    setStatus('correct')
    setTimeout(() => {
      advanceOpponentMove()
      setStatus('solving')
    }, 400)
    return true
  }, [status, finishAttempt, advanceOpponentMove])

  const giveUp = useCallback(() => {
    if (status !== 'solving' && status !== 'correct') return
    finishAttempt(false)
  }, [status, finishAttempt])

  useEffect(() => { loadPuzzle() }, [loadPuzzle])

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
    onUserMove,
    loadNextPuzzle: loadPuzzle,
    giveUp,
  }
}
