import { Chessboard } from 'react-chessboard'
import { BOARD_THEMES, DEFAULT_BOARD_THEME, accentRgba } from '../utils/theme'

const STATUS_RING = {
  solved: 'ring-2 ring-emerald-500/70',
  failed: 'ring-2 ring-red-500/70',
  correct: 'ring-2 ring-accent/70',
}

export default function Board({ fen, orientation, status, lastMove, onUserMove, boardTheme, appMode }) {
  const isPlayable = status === 'solving'
  const { light: lightSquare, dark: darkSquare } = BOARD_THEMES[boardTheme] ?? BOARD_THEMES[DEFAULT_BOARD_THEME]
  const highlight = accentRgba(appMode, 0.35) // accent glow on last move

  function handlePieceDrop(sourceSquare, targetSquare, piece) {
    if (!isPlayable) return false
    return onUserMove(sourceSquare, targetSquare, piece)
  }

  const customSquareStyles = {}
  if (lastMove) {
    customSquareStyles[lastMove.from] = { backgroundColor: highlight }
    customSquareStyles[lastMove.to]   = { backgroundColor: highlight }
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
