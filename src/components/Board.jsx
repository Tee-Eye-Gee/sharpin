import { Chessboard } from 'react-chessboard'

const DARK_SQUARE  = '#2C2C2C'
const LIGHT_SQUARE = '#4A4A4A'
const HIGHLIGHT    = 'rgba(212, 160, 23, 0.35)' // amber glow on last move

const STATUS_RING = {
  solved: 'ring-2 ring-emerald-500/70',
  failed: 'ring-2 ring-red-500/70',
  correct: 'ring-2 ring-[#D4A017]/70',
}

export default function Board({ fen, orientation, status, lastMove, onUserMove }) {
  const isPlayable = status === 'solving'

  function handlePieceDrop(sourceSquare, targetSquare, piece) {
    if (!isPlayable) return false
    return onUserMove(sourceSquare, targetSquare, piece)
  }

  const customSquareStyles = {}
  if (lastMove) {
    customSquareStyles[lastMove.from] = { backgroundColor: HIGHLIGHT }
    customSquareStyles[lastMove.to]   = { backgroundColor: HIGHLIGHT }
  }

  const ringClass = STATUS_RING[status] ?? ''

  return (
    <div className={`relative w-full rounded-lg transition-all ${ringClass}`}>
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-lg pointer-events-none">
          <ThinkingDots />
        </div>
      )}

      {fen && (
        <Chessboard
          position={fen}
          onPieceDrop={handlePieceDrop}
          boardOrientation={orientation}
          arePiecesDraggable={isPlayable}
          customDarkSquareStyle={{ backgroundColor: DARK_SQUARE }}
          customLightSquareStyle={{ backgroundColor: LIGHT_SQUARE }}
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
          className="w-1.5 h-1.5 rounded-full bg-[#D4A017] animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}
