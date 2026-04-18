import { useState, useEffect, useCallback, useRef } from 'react'
import { Chess } from 'chess.js'
import { assessMove, updatePerformanceScore } from '../utils/difficulty'

const TIME_SECONDS = { casual: null, rapid: 600, blitz: 300, bullet: 180 }
const INITIAL_SCORE = 50

// Build a legal-move list in UCI format from a Chess instance
function legalMovesUCI(chess) {
  return chess.moves({ verbose: true }).map(
    (m) => m.from + m.to + (m.promotion ?? '')
  )
}

// Parse a UCI string into a chess.js move object
function uciToMove(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : 'q',
  }
}

export function useGameEngine() {
  // ---------- stable refs (don't trigger renders) ----------
  const chessRef       = useRef(new Chess())
  const gameIdRef      = useRef(0)           // incremented on new game; cancels stale async ops
  const perfRef        = useRef(INITIAL_SCORE)
  const historyRef     = useRef([])          // [{ san, color }]
  const statusRef      = useRef('idle')      // mirrors gameStatus
  const timeControlRef = useRef('casual')
  const turnRef        = useRef('w')
  const thinkingRef    = useRef(false)       // mirrors isTheoThinking

  // ---------- rendered state ----------
  const [fen,              setFen]              = useState(chessRef.current.fen())
  const [gameStatus,       setGameStatus]       = useState('idle')   // idle|playing|gameover
  const [gameResult,       setGameResult]       = useState(null)     // { type, winner }
  const [turn,             setTurn]             = useState('w')
  const [performanceScore, setPerformanceScore] = useState(INITIAL_SCORE)
  const [moveHistory,      setMoveHistory]      = useState([])
  const [theoComment,      setTheoComment]      = useState('')
  const [isTheoThinking,   setIsTheoThinking]   = useState(false)
  const [timeControl,      setTimeControl]      = useState('casual')
  const [whiteTime,        setWhiteTime]        = useState(null)
  const [blackTime,        setBlackTime]        = useState(null)

  // Keep refs in sync
  useEffect(() => { statusRef.current  = gameStatus },       [gameStatus])
  useEffect(() => { turnRef.current    = turn },             [turn])
  useEffect(() => { thinkingRef.current = isTheoThinking },  [isTheoThinking])
  useEffect(() => { perfRef.current    = performanceScore }, [performanceScore])
  useEffect(() => { historyRef.current = moveHistory },      [moveHistory])

  // ---------- timer ----------
  useEffect(() => {
    if (gameStatus !== 'playing' || timeControl === 'casual') return
    const id = setInterval(() => {
      if (turnRef.current === 'w') {
        setWhiteTime((t) => {
          if (t === null || t <= 1) { handleTimeout('w'); return 0 }
          return t - 1
        })
      } else {
        setBlackTime((t) => {
          if (t === null || t <= 1) { handleTimeout('b'); return 0 }
          return t - 1
        })
      }
    }, 1000)
    return () => clearInterval(id)
  }, [gameStatus, timeControl]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleTimeout(loser) {
    setGameStatus('gameover')
    statusRef.current = 'gameover'
    setGameResult({
      type: 'timeout',
      winner: loser === 'b' ? 'theo' : 'tiggs',
    })
  }

  // ---------- game-over detection ----------
  const checkGameOver = useCallback((chess) => {
    if (chess.isCheckmate()) {
      // chess.turn() is the player who was checkmated (can't move)
      const loser = chess.turn()            // 'w' or 'b'
      setGameStatus('gameover')
      statusRef.current = 'gameover'
      setGameResult({
        type: 'checkmate',
        winner: loser === 'b' ? 'theo' : 'tiggs',
      })
      return true
    }
    if (chess.isStalemate() || chess.isDraw()) {
      setGameStatus('gameover')
      statusRef.current = 'gameover'
      setGameResult({ type: 'draw', winner: null })
      return true
    }
    return false
  }, [])

  // ---------- Theo's move (with retry) ----------
  const requestTheoMove = useCallback(async (gameId) => {
    if (thinkingRef.current) return
    thinkingRef.current = true
    setIsTheoThinking(true)

    const chess  = chessRef.current
    const legal  = legalMovesUCI(chess)

    if (legal.length === 0) { setIsTheoThinking(false); thinkingRef.current = false; return }

    let chosenUCI = null
    let comment   = ''

    for (let attempt = 0; attempt < 3; attempt++) {
      // Abort if the game was reset mid-flight
      if (gameIdRef.current !== gameId) { setIsTheoThinking(false); thinkingRef.current = false; return }

      try {
        const res = await fetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fen:             chess.fen(),
            history:         historyRef.current.slice(-10).map((m) => m.san),
            difficultyScore: perfRef.current,
            timeControl:     timeControlRef.current,
            legalMoves:      legal,
          }),
        })

        if (!res.ok) continue

        const data = await res.json()

        if (data.move && legal.includes(data.move)) {
          chosenUCI = data.move
          comment   = data.comment ?? ''
          break
        }
      } catch (err) {
        console.warn(`Theo move attempt ${attempt + 1} failed:`, err)
      }
    }

    // Bail if game was reset while we were waiting
    if (gameIdRef.current !== gameId) { setIsTheoThinking(false); thinkingRef.current = false; return }

    // Fallback: random legal move
    if (!chosenUCI) {
      chosenUCI = legal[Math.floor(Math.random() * legal.length)]
      comment   = ''
    }

    try {
      const result = chess.move(uciToMove(chosenUCI))
      if (result) {
        const newFen = chess.fen()
        setFen(newFen)
        setTheoComment(comment)
        setMoveHistory((prev) => [...prev, { san: result.san, color: 'w' }])
        historyRef.current = [...historyRef.current, { san: result.san, color: 'w' }]

        const newTurn = chess.turn()
        turnRef.current = newTurn
        setTurn(newTurn)

        checkGameOver(chess)
      }
    } catch (err) {
      console.error('Failed to apply Theo move:', err)
    }

    setIsTheoThinking(false)
    thinkingRef.current = false
  }, [checkGameOver])

  // Auto-trigger Theo when it's white's turn and game is active
  useEffect(() => {
    if (gameStatus === 'playing' && turn === 'w' && !isTheoThinking) {
      requestTheoMove(gameIdRef.current)
    }
  }, [gameStatus, turn, isTheoThinking, requestTheoMove])

  // ---------- Tiggs's move ----------
  const onTiggsMoved = useCallback((sourceSquare, targetSquare) => {
    if (statusRef.current !== 'playing') return false
    if (turnRef.current !== 'b')         return false
    if (thinkingRef.current)             return false

    const chess      = chessRef.current
    const chessBefore = new Chess(chess.fen())  // snapshot before move

    let result
    try {
      result = chess.move({ from: sourceSquare, to: targetSquare, promotion: 'q' })
    } catch {
      return false
    }
    if (!result) return false

    // Assess and update difficulty
    const chessAfter   = new Chess(chess.fen())  // snapshot after move (white to move)
    const assessment   = assessMove(chessBefore, chessAfter)
    const newScore     = updatePerformanceScore(perfRef.current, assessment)
    perfRef.current    = newScore
    setPerformanceScore(newScore)

    const newFen = chess.fen()
    setFen(newFen)
    setMoveHistory((prev) => [...prev, { san: result.san, color: 'b' }])
    historyRef.current = [...historyRef.current, { san: result.san, color: 'b' }]

    const newTurn = chess.turn()
    turnRef.current = newTurn
    setTurn(newTurn)

    checkGameOver(chess)
    return true
  }, [checkGameOver])

  // ---------- new game ----------
  const startNewGame = useCallback((selectedTimeControl = 'casual') => {
    gameIdRef.current += 1
    const gid = gameIdRef.current

    chessRef.current.reset()
    const secs = TIME_SECONDS[selectedTimeControl] ?? null

    // Reset all state
    perfRef.current         = INITIAL_SCORE
    historyRef.current      = []
    timeControlRef.current  = selectedTimeControl
    thinkingRef.current     = false

    setFen(chessRef.current.fen())
    setTurn('w')
    turnRef.current = 'w'
    setGameStatus('playing')
    statusRef.current = 'playing'
    setGameResult(null)
    setMoveHistory([])
    setPerformanceScore(INITIAL_SCORE)
    setTheoComment('')
    setIsTheoThinking(false)
    setTimeControl(selectedTimeControl)
    setWhiteTime(secs)
    setBlackTime(secs)

    // Theo moves first (white) — let useEffect pick it up via turn='w'
    // We trigger manually here so we can pass the correct gameId
    setTimeout(() => {
      if (gameIdRef.current === gid) {
        requestTheoMove(gid)
      }
    }, 0)
  }, [requestTheoMove])

  // ---------- resign ----------
  const resign = useCallback(() => {
    if (statusRef.current !== 'playing') return
    gameIdRef.current += 1       // cancel any in-flight Theo request
    setGameStatus('gameover')
    statusRef.current = 'gameover'
    setGameResult({ type: 'resigned', winner: 'theo' })
    setIsTheoThinking(false)
    thinkingRef.current = false
  }, [])

  return {
    fen,
    gameStatus,
    gameResult,
    turn,
    performanceScore,
    moveHistory,
    theoComment,
    isTheoThinking,
    timeControl,
    whiteTime,
    blackTime,
    onTiggsMoved,
    startNewGame,
    resign,
  }
}
