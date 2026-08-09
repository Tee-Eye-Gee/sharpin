import { useState, useRef, useEffect, useLayoutEffect } from 'react'

// Shared tap-to-define trigger + popover: previously duplicated verbatim in
// PuzzleControls.jsx (theme-chip definitions) and CoachNote.jsx (Coach Note
// label) -- see docs/specs/Sharpin_Spec_HintSystem.md §11 for the duplication
// history. Extracted here to fix a shared bug: the popover had no explicit
// width (only an unused max-width), so it shrink-wrapped to its trigger's
// tiny width instead of using available screen space, forcing near
// single-word-per-line wrapping on both mobile and desktop.
const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 16

const DEFAULT_TRIGGER_CLASSNAME =
  'text-xs px-2 py-1 rounded-full bg-accent/10 border border-accent/30 text-accent'

/**
 * @param {object} props
 * @param {import('react').ReactNode} props.label - trigger button content
 * @param {import('react').ReactNode} [props.title] - optional bold header line inside the popover
 * @param {import('react').ReactNode} props.definition - popover body text
 * @param {boolean} [props.isOpen] - controlled open state; omit for internal (uncontrolled) state
 * @param {(next: boolean) => void} [props.onToggle] - required when `isOpen` is controlled
 * @param {string} [props.triggerClassName] - override the trigger button's classes
 * @param {string} [props.wrapperClassName] - extra classes on the positioning wrapper (e.g. `self-start` in a flex column)
 */
export default function DefinitionPopover({
  label,
  title,
  definition,
  isOpen: controlledIsOpen,
  onToggle,
  triggerClassName = DEFAULT_TRIGGER_CLASSNAME,
  wrapperClassName = '',
}) {
  const isControlled = controlledIsOpen !== undefined
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = isControlled ? controlledIsOpen : internalOpen

  function setOpen(next) {
    if (isControlled) onToggle?.(next)
    else setInternalOpen(next)
  }

  const [popoverOffset, setPopoverOffset] = useState(0)
  const wrapperRef = useRef(null)
  const triggerRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    function handleOutsideTap(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideTap)
    document.addEventListener('touchstart', handleOutsideTap)
    return () => {
      document.removeEventListener('mousedown', handleOutsideTap)
      document.removeEventListener('touchstart', handleOutsideTap)
    }
  }, [isOpen])

  // Keep the popover inside the viewport horizontally. Runs before paint, so
  // there's no flash at the wrong position -- computed from the known width
  // rather than a measure-then-flip pass.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) { setPopoverOffset(0); return }
    const rect = triggerRef.current.getBoundingClientRect()
    const maxLeft = window.innerWidth - VIEWPORT_MARGIN - POPOVER_WIDTH
    const minLeft = VIEWPORT_MARGIN
    const desiredLeft = Math.min(Math.max(rect.left, minLeft), Math.max(maxLeft, minLeft))
    setPopoverOffset(desiredLeft - rect.left)
  }, [isOpen])

  return (
    <span className={`relative ${wrapperClassName}`} ref={wrapperRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!isOpen)}
        className={triggerClassName}
      >
        {label}
      </button>
      {isOpen && (
        <div
          className="absolute z-30 top-full mt-1.5 rounded-lg border border-border bg-surface p-3 shadow-xl"
          style={{ left: `${popoverOffset}px`, width: `min(${POPOVER_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))` }}
        >
          {title && <p className="text-xs font-semibold text-fg mb-1">{title}</p>}
          <p className="text-xs text-fg-muted leading-relaxed">{definition}</p>
        </div>
      )}
    </span>
  )
}
