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
        <h2 className="text-xs text-fg-muted uppercase tracking-widest font-medium mb-2">
          This puzzle
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {puzzleRating && (
            <span className="text-xs font-mono px-2 py-1 rounded-full bg-surface border border-border-strong text-fg-muted">
              {puzzleRating}
            </span>
          )}
          {currentThemes.slice(0, 4).map((theme) => (
            <span
              key={theme}
              className="text-xs px-2 py-1 rounded-full bg-accent/10 border border-accent/30 text-accent"
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
                     bg-accent text-black hover:brightness-110 active:scale-95"
        >
          Next Puzzle
        </button>
      ) : (
        <button
          onClick={onGiveUp}
          disabled={!isActive}
          className="w-full rounded-lg py-2 text-sm font-medium text-fg-muted
                     border border-border-strong hover:border-red-900 hover:text-red-400
                     transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
        >
          Give Up
        </button>
      )}
    </div>
  )
}
