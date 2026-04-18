import { getDifficultyLabel } from '../utils/difficulty'

const BAND_COLORS = {
  Casual:      'text-neutral-500',
  Solid:       'text-blue-400',
  Competitive: 'text-amber-400',
  Sharp:       'text-red-400',
}

function DifficultyBadge({ score }) {
  const label = getDifficultyLabel(score)
  return (
    <span className={`text-xs font-semibold uppercase tracking-widest ${BAND_COLORS[label]}`}>
      {label}
    </span>
  )
}

export default function StatusBar({
  gameStatus,
  gameResult,
  turn,
  isTheoThinking,
  theoComment,
  performanceScore,
}) {
  let headline = ''
  let subline  = theoComment

  if (gameStatus === 'idle') {
    headline = 'Start a game to play'
    subline  = ''
  } else if (gameStatus === 'gameover' && gameResult) {
    if (gameResult.type === 'checkmate') {
      headline = gameResult.winner === 'tiggs'
        ? 'Checkmate — Tiggs wins!'
        : 'Checkmate — Theo wins!'
    } else if (gameResult.type === 'resigned') {
      headline = 'Tiggs resigned. Theo wins.'
    } else if (gameResult.type === 'timeout') {
      headline = gameResult.winner === 'tiggs'
        ? 'Time — Tiggs wins!'
        : 'Time — Theo wins!'
    } else {
      headline = 'Draw'
    }
    subline = ''
  } else if (gameStatus === 'playing') {
    if (isTheoThinking) {
      headline = "Theo's turn"
    } else if (turn === 'b') {
      headline = "Your turn, Tiggs"
    } else {
      headline = "Theo's turn"
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 px-1">
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-semibold text-neutral-200 truncate">
          {headline}
        </span>
        {subline && (
          <span className="text-xs text-neutral-500 italic truncate mt-0.5">
            "{subline}"
          </span>
        )}
      </div>

      {gameStatus !== 'idle' && (
        <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
          <DifficultyBadge score={performanceScore} />
          <div className="w-24 h-1 rounded-full bg-[#2a2a2a] overflow-hidden">
            <div
              className="h-full rounded-full bg-[#D4A017] transition-all duration-500"
              style={{ width: `${performanceScore}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
