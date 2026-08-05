import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { formatTheme } from '../utils/themeLabels'
import { THEME_DEFINITIONS } from '../utils/tacticalLexicon'

// Matches the popover's own max-width cap below -- used to compute a
// viewport-safe horizontal offset before the popover ever paints.
const POPOVER_MAX_WIDTH = 280
const VIEWPORT_MARGIN = 12

export default function PuzzleControls({
  status,
  puzzleRating,
  currentThemes,
  isRetrying,
  onNextPuzzle,
  onGiveUp,
  onRetry,
}) {
  const isSolved = status === 'solved'
  const isFailed = status === 'failed'
  const isActive = status === 'solving' || status === 'correct'
  // Retry offered whenever the puzzle is failed (original or post-retry) or
  // a retry attempt is in progress -- covers the whole post-fail lifecycle
  // without ever re-arming Give Up. Once a retry is solved, only Next
  // Puzzle applies (same as a genuine first-try solve).
  const showRetryRow = isFailed || (isRetrying && !isSolved)
  const showNextOnly = isSolved

  // Tactical Lexicon: tap a theme chip for its plain-English definition.
  // Scoped to this component -- no shared tooltip/popover exists elsewhere
  // in the codebase, so this is a minimal, self-contained implementation
  // rather than a new generic component.
  const [openTheme, setOpenTheme] = useState(null) // raw theme id, or null
  const [popoverOffset, setPopoverOffset] = useState(0) // px, relative to the chip's own left edge
  const chipsRef = useRef(null)
  const activeChipRef = useRef(null) // set only on the currently-open chip's wrapper

  useEffect(() => {
    if (!openTheme) return
    function handleOutsideTap(e) {
      if (chipsRef.current && !chipsRef.current.contains(e.target)) setOpenTheme(null)
    }
    document.addEventListener('mousedown', handleOutsideTap)
    document.addEventListener('touchstart', handleOutsideTap)
    return () => {
      document.removeEventListener('mousedown', handleOutsideTap)
      document.removeEventListener('touchstart', handleOutsideTap)
    }
  }, [openTheme])

  // Keep the popover inside the viewport horizontally. Runs before paint, so
  // there's no flash at the wrong position -- computed from the known
  // max-width cap rather than a measure-then-flip pass.
  useLayoutEffect(() => {
    if (!openTheme || !activeChipRef.current) { setPopoverOffset(0); return }
    const chipRect = activeChipRef.current.getBoundingClientRect()
    const maxLeft = window.innerWidth - VIEWPORT_MARGIN - POPOVER_MAX_WIDTH
    const minLeft = VIEWPORT_MARGIN
    const desiredLeft = Math.min(Math.max(chipRect.left, minLeft), Math.max(maxLeft, minLeft))
    setPopoverOffset(desiredLeft - chipRect.left)
  }, [openTheme])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xs text-fg-muted uppercase tracking-widest font-medium mb-2">
          This puzzle
        </h2>
        <div ref={chipsRef} className="flex flex-wrap gap-1.5">
          {puzzleRating && (
            <span className="text-xs font-mono px-2 py-1 rounded-full bg-surface border border-border-strong text-fg-muted">
              {puzzleRating}
            </span>
          )}
          {currentThemes.slice(0, 4).map((theme) => (
            <span key={theme} className="relative" ref={openTheme === theme ? activeChipRef : null}>
              <button
                type="button"
                onClick={() => setOpenTheme((prev) => (prev === theme ? null : theme))}
                className="text-xs px-2 py-1 rounded-full bg-accent/10 border border-accent/30 text-accent"
              >
                {formatTheme(theme)}
              </button>
              {openTheme === theme && (
                <div
                  className="absolute z-30 top-full mt-1.5 rounded-lg border border-border bg-surface p-3 shadow-xl"
                  style={{ left: `${popoverOffset}px`, maxWidth: `min(${POPOVER_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))` }}
                >
                  <p className="text-xs font-semibold text-fg mb-1">{formatTheme(theme)}</p>
                  {/* Some Lichess theme tags have no lexicon entry -- fall back
                      to a plain message rather than showing nothing. */}
                  <p className="text-xs text-fg-muted leading-relaxed">
                    {THEME_DEFINITIONS[theme] ?? 'No definition available yet for this tag.'}
                  </p>
                </div>
              )}
            </span>
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
      ) : showNextOnly ? (
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
