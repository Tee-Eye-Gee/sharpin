import { useState } from 'react'
import { formatTheme } from '../utils/themeLabels'
import { THEME_DEFINITIONS } from '../utils/tacticalLexicon'
import DefinitionPopover from './DefinitionPopover'

export default function PuzzleControls({
  status,
  puzzleRating,
  currentThemes,
  isRetrying,
  onNextPuzzle,
  onHint,
  onRetry,
}) {
  const isResolved = status === 'solved' || status === 'failed'
  // 4-state row (spec §7, extended to unlimited retry per §10a):
  //   resolved (any cycle, first attempt or Nth retry)  -> Retry + Next Puzzle
  //   attempting + isRetrying (follow-up, mid-attempt)  -> Hint + Next Puzzle
  //   attempting + !isRetrying (initial try)             -> Hint only
  // Order matters: a resolved follow-up attempt (isRetrying true, status
  // solved/failed) must hit the Retry+Next row, not the Hint+Next one --
  // isRetrying only distinguishes the *mid-attempt* rows once resolved is
  // ruled out.
  const showRetryRow = isResolved
  const showHintNextRow = !isResolved && isRetrying
  const canHint = status === 'solving'

  // Tactical Lexicon: tap a theme chip for its plain-English definition.
  // Only one chip's definition shows at a time -- `openTheme` is lifted here
  // (rather than left to each DefinitionPopover's own internal state) so
  // opening one chip controls the others closed via the shared value.
  const [openTheme, setOpenTheme] = useState(null) // raw theme id, or null

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
            <DefinitionPopover
              key={theme}
              label={formatTheme(theme)}
              title={formatTheme(theme)}
              // Some Lichess theme tags have no lexicon entry -- fall back to
              // a plain message rather than showing nothing.
              definition={THEME_DEFINITIONS[theme] ?? 'No definition available yet for this tag.'}
              isOpen={openTheme === theme}
              onToggle={(next) => setOpenTheme(next ? theme : null)}
            />
          ))}
        </div>
      </div>

      {showRetryRow ? (
        <div className="flex gap-2">
          <button
            onClick={onRetry}
            className="flex-1 rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                       border border-accent/40 text-accent hover:bg-accent/10 active:scale-95"
          >
            Retry
          </button>
          <button
            onClick={onNextPuzzle}
            className="flex-1 rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                       bg-accent text-black hover:brightness-110 active:scale-95"
          >
            Next Puzzle
          </button>
        </div>
      ) : showHintNextRow ? (
        <div className="flex gap-2">
          <button
            onClick={onHint}
            disabled={!canHint}
            className="flex-1 rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                       border border-accent/40 text-accent hover:bg-accent/10 active:scale-95
                       disabled:opacity-40 disabled:pointer-events-none"
          >
            Hint
          </button>
          <button
            onClick={onNextPuzzle}
            className="flex-1 rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                       bg-accent text-black hover:brightness-110 active:scale-95"
          >
            Next Puzzle
          </button>
        </div>
      ) : (
        <button
          onClick={onHint}
          disabled={!canHint}
          className="w-full rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                     border border-accent/40 text-accent hover:bg-accent/10 active:scale-95
                     disabled:opacity-40 disabled:pointer-events-none"
        >
          Hint
        </button>
      )}
    </div>
  )
}
