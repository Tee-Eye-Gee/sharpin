import { formatTheme } from '../utils/themeLabels'

export default function PuzzleControls({
  status,
  puzzleRating,
  currentThemes,
  onNextPuzzle,
  onGiveUp,
}) {
  const isDone = status === 'solved' || status === 'failed'
  const isActive = status === 'solving' || status === 'correct'

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xs text-neutral-600 uppercase tracking-widest font-medium mb-2">
          This puzzle
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {puzzleRating && (
            <span className="text-xs font-mono px-2 py-1 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] text-neutral-400">
              {puzzleRating}
            </span>
          )}
          {currentThemes.slice(0, 4).map((theme) => (
            <span
              key={theme}
              className="text-xs px-2 py-1 rounded-full bg-[#1a1400] border border-[#D4A017]/30 text-[#D4A017]"
            >
              {formatTheme(theme)}
            </span>
          ))}
        </div>
      </div>

      {isDone ? (
        <button
          onClick={onNextPuzzle}
          className="w-full rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                     bg-[#D4A017] text-black hover:bg-[#e8b520] active:scale-95"
        >
          Next Puzzle
        </button>
      ) : (
        <button
          onClick={onGiveUp}
          disabled={!isActive}
          className="w-full rounded-lg py-2 text-sm font-medium text-neutral-500
                     border border-[#2a2a2a] hover:border-red-900 hover:text-red-400
                     transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
        >
          Give Up
        </button>
      )}
    </div>
  )
}
