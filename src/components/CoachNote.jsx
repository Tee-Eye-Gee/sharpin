import DefinitionPopover from './DefinitionPopover'

const COACH_NOTE_DEFINITION =
  "Coach notes are generated from your first attempt at this puzzle and don't account for hints or retries."

export default function CoachNote({ status, coachNote }) {
  if (status !== 'solved' && status !== 'failed') return null
  if (!coachNote) return null

  return (
    <div className="px-1 min-h-[1.5rem] flex flex-col gap-1">
      <DefinitionPopover
        label="Coach Note"
        definition={COACH_NOTE_DEFINITION}
        wrapperClassName="self-start"
      />
      <span className="text-sm text-fg-muted italic">"{coachNote}"</span>
    </div>
  )
}
