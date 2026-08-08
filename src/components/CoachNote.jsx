import { useState, useRef, useEffect, useLayoutEffect } from 'react'

// Reuses the exact tap-to-define popover mechanism from PuzzleControls.jsx's
// theme-label chips (same visual treatment, same open/outside-tap-close/
// viewport-safe-position logic) -- see
// docs/specs/Sharpin_Spec_HintSystem.md §11. Scoped to this component, same
// as the theme-chip original: no shared popover component exists to reuse.
const POPOVER_MAX_WIDTH = 280
const VIEWPORT_MARGIN = 12

const COACH_NOTE_DEFINITION =
  "Coach notes are generated from your first attempt at this puzzle and don't account for hints or retries."

export default function CoachNote({ status, coachNote }) {
  const [isOpen, setIsOpen] = useState(false)
  const [popoverOffset, setPopoverOffset] = useState(0)
  const wrapperRef = useRef(null)
  const labelRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    function handleOutsideTap(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideTap)
    document.addEventListener('touchstart', handleOutsideTap)
    return () => {
      document.removeEventListener('mousedown', handleOutsideTap)
      document.removeEventListener('touchstart', handleOutsideTap)
    }
  }, [isOpen])

  // Keep the popover inside the viewport horizontally. Runs before paint, so
  // there's no flash at the wrong position -- computed from the known
  // max-width cap rather than a measure-then-flip pass.
  useLayoutEffect(() => {
    if (!isOpen || !labelRef.current) { setPopoverOffset(0); return }
    const rect = labelRef.current.getBoundingClientRect()
    const maxLeft = window.innerWidth - VIEWPORT_MARGIN - POPOVER_MAX_WIDTH
    const minLeft = VIEWPORT_MARGIN
    const desiredLeft = Math.min(Math.max(rect.left, minLeft), Math.max(maxLeft, minLeft))
    setPopoverOffset(desiredLeft - rect.left)
  }, [isOpen])

  if (status !== 'solved' && status !== 'failed') return null
  if (!coachNote) return null

  return (
    <div className="px-1 min-h-[1.5rem] flex flex-col gap-1">
      <span className="relative self-start" ref={wrapperRef}>
        <button
          type="button"
          ref={labelRef}
          onClick={() => setIsOpen((prev) => !prev)}
          className="text-xs px-2 py-1 rounded-full bg-accent/10 border border-accent/30 text-accent"
        >
          Coach Note
        </button>
        {isOpen && (
          <div
            className="absolute z-30 top-full mt-1.5 rounded-lg border border-border bg-surface p-3 shadow-xl"
            style={{ left: `${popoverOffset}px`, maxWidth: `min(${POPOVER_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))` }}
          >
            <p className="text-xs text-fg-muted leading-relaxed">{COACH_NOTE_DEFINITION}</p>
          </div>
        )}
      </span>
      <span className="text-sm text-fg-muted italic">"{coachNote}"</span>
    </div>
  )
}
