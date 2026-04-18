import { Chessboard } from 'react-chessboard'

// Board color palette
const DARK_SQUARE  = '#2C2C2C'
const LIGHT_SQUARE = '#4A4A4A'
const HIGHLIGHT    = 'rgba(212, 160, 23, 0.35)'  // amber glow on last move

export default function Board({ fen, onTiggsMoved, isTheoThinking, gameStatus, lastMove }) {
  const isPlayable = gameStatus === 'playing' && !isTheoThinking

  function handlePieceDrop(sourceSquare, targetSquare) {
    if (!isPlayable) return false
    return onTiggsMoved(sourceSquare, targetSquare)
  }

  // Highlight last move squares
  const customSquareStyles = {}
  if (lastMove) {
    customSquareStyles[lastMove.from] = { backgroundColor: HIGHLIGHT }
    customSquareStyles[lastMove.to]   = { backgroundColor: HIGHLIGHT }
  }

  return (
    <div className="relative w-full">
      {/* Thinking overlay */}
      {isTheoThinking && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="bg-black/60 rounded-lg px-4 py-2 flex items-center gap-2">
            <ThinkingDots />
            <span className="text-[#D4A017] text-sm font-medium tracking-wide">
              Theo is thinking
            </span>
          </div>
        </div>
      )}

      <Chessboard
        position={fen}
        onPieceDrop={handlePieceDrop}
        boardOrientation="black"
        arePiecesDraggable={isPlayable}
        customDarkSquareStyle={{ backgroundColor: DARK_SQUARE }}
        customLightSquareStyle={{ backgroundColor: LIGHT_SQUARE }}
        customSquareStyles={customSquareStyles}
        animationDuration={200}
      />
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
