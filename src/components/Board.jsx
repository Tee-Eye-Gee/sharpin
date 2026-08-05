import { useState, useEffect, useMemo } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { BOARD_THEMES, DEFAULT_BOARD_THEME, accentRgba, moveIndicatorRgba } from '../utils/theme'

const STATUS_RING = {
  solved: 'ring-2 ring-emerald-500/70',
  failed: 'ring-2 ring-red-500/70',
  correct: 'ring-2 ring-accent/70',
}

const PROMOTION_PIECES = [
  { code: 'q', label: 'Queen' },
  { code: 'r', label: 'Rook' },
  { code: 'b', label: 'Bishop' },
  { code: 'n', label: 'Knight' },
]

// a1 is a dark square; standard (file + rank) parity determines the rest.
function isLightSquare(square) {
  const file = square.charCodeAt(0) - 97
  const rank = parseInt(square[1], 10)
  return (file + rank) % 2 === 0
}

// Legal destinations from `square`, deduped across the (up to 4)
// promotion-piece move variants chess.js returns for the same from/to pair.
// Display-only: this never decides whether a move is the puzzle's correct
// solution -- that's still onUserMove's job, untouched here.
function getLegalDestinations(chess, square) {
  const destinations = new Map()
  for (const move of chess.moves({ square, verbose: true })) {
    const existing = destinations.get(move.to) ?? { isCapture: false, isPromotion: false }
    if (move.captured) existing.isCapture = true
    if (move.promotion) existing.isPromotion = true
    destinations.set(move.to, existing)
  }
  return destinations
}

export default function Board({ fen, orientation, status, lastMove, onUserMove, boardTheme, appMode, inputMode }) {
  const isPlayable = status === 'solving'
  const isTapMode = inputMode === 'tap'
  const { light: lightSquare, dark: darkSquare } = BOARD_THEMES[boardTheme] ?? BOARD_THEMES[DEFAULT_BOARD_THEME]
  const highlight = accentRgba(appMode, 0.35) // accent glow on last move / selection

  // Tap-mode selection state machine (spec: Sharpin_Spec_ClickToMove.md §2).
  // Drag mode never touches either of these.
  const [selection, setSelection] = useState(null) // { square, piece } | null
  const [pendingPromotion, setPendingPromotion] = useState(null) // { from, to, color } | null

  // A puzzle transition (next puzzle, opponent auto-reply, solved/failed)
  // must not leave a stale selection or an open promotion picker behind.
  useEffect(() => {
    if (status !== 'solving') {
      setSelection(null)
      setPendingPromotion(null)
    }
  }, [status])

  const legalDestinations = useMemo(() => {
    if (!isTapMode || !selection || !fen) return new Map()
    return getLegalDestinations(new Chess(fen), selection.square)
  }, [isTapMode, selection, fen])

  // Shared commit path for both input methods -- unchanged from the
  // drag-and-drop implementation. Tap mode reaches this exact function via
  // handleSquareClick/choosePromotion instead of react-chessboard's
  // onPieceDrop; it never forks or duplicates what happens after this call.
  function handlePieceDrop(sourceSquare, targetSquare, piece) {
    if (!isPlayable) return false
    return onUserMove(sourceSquare, targetSquare, piece)
  }

  function isOwnPieceToMove(piece) {
    return !!fen && piece[0] === new Chess(fen).turn()
  }

  function handleSquareClick(square, piece) {
    if (!isPlayable || pendingPromotion) return

    if (!selection) {
      if (piece && isOwnPieceToMove(piece)) setSelection({ square, piece })
      return
    }

    if (square === selection.square) {
      setSelection(null) // tap same piece again -> deselect
      return
    }

    const destination = legalDestinations.get(square)
    if (destination) {
      if (destination.isPromotion) {
        setPendingPromotion({ from: selection.square, to: square, color: selection.piece[0] })
      } else {
        handlePieceDrop(selection.square, square, selection.piece)
        setSelection(null)
      }
      return
    }

    if (piece && isOwnPieceToMove(piece)) {
      setSelection(null) // deselect only -- user must tap the new piece again to select it
      return
    }

    setSelection(null) // illegal square -- silent deselect, no error state
  }

  function choosePromotion(pieceLetter) {
    if (!pendingPromotion) return
    const pieceCode = `${pendingPromotion.color}${pieceLetter.toUpperCase()}`
    handlePieceDrop(pendingPromotion.from, pendingPromotion.to, pieceCode)
    setPendingPromotion(null)
    setSelection(null)
  }

  const customSquareStyles = {}
  if (lastMove) {
    customSquareStyles[lastMove.from] = { backgroundColor: highlight }
    customSquareStyles[lastMove.to]   = { backgroundColor: highlight }
  }
  if (isTapMode && selection) {
    customSquareStyles[selection.square] = { backgroundColor: highlight }
    for (const [square, info] of legalDestinations) {
      const base = isLightSquare(square) ? lightSquare : darkSquare
      // A dark outline (behind the colored shape) makes these readable on
      // dark squares too, where the indicator color's own contrast is weak —
      // visibility comes from the edge, not from color-vs-square contrast.
      customSquareStyles[square] = info.isCapture
        ? { backgroundColor: base, boxShadow: `inset 0 0 0 4px ${moveIndicatorRgba(appMode, 0.55)}, inset 0 0 0 5px rgba(0, 0, 0, 0.35)` }
        : { backgroundColor: base, backgroundImage: `radial-gradient(circle, ${moveIndicatorRgba(appMode, 0.45)} 22%, transparent 24%), radial-gradient(circle, rgba(0, 0, 0, 0.35) 24%, transparent 26%)` }
    }
  }

  const ringClass = STATUS_RING[status] ?? ''

  return (
    <div className={`relative w-full rounded-lg transition-all ${ringClass}`}>
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-lg pointer-events-none">
          <ThinkingDots />
        </div>
      )}

      {pendingPromotion && <PromotionPicker onSelect={choosePromotion} />}

      {fen && (
        <Chessboard
          position={fen}
          onPieceDrop={isTapMode ? undefined : handlePieceDrop}
          onSquareClick={isTapMode ? handleSquareClick : undefined}
          boardOrientation={orientation}
          arePiecesDraggable={!isTapMode && isPlayable}
          customDarkSquareStyle={{ backgroundColor: darkSquare }}
          customLightSquareStyle={{ backgroundColor: lightSquare }}
          customSquareStyles={customSquareStyles}
          animationDuration={200}
        />
      )}
    </div>
  )
}

function ThinkingDots() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}

function PromotionPicker({ onSelect }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 rounded-lg">
      <div className="flex gap-2 rounded-lg border border-border bg-surface p-3 shadow-xl">
        {PROMOTION_PIECES.map(({ code, label }) => (
          <button
            key={code}
            onClick={() => onSelect(code)}
            aria-label={`Promote to ${label}`}
            className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-lg border border-border
                       text-fg transition-all hover:border-accent hover:bg-accent/10 active:scale-95"
          >
            <span className="text-lg font-bold uppercase">{code}</span>
            <span className="text-[10px] text-fg-muted">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
