export default function CoachNote({ status, coachNote, isCoaching }) {
  if (status !== 'solved' && status !== 'failed') return null

  return (
    <div className="px-1 min-h-[1.5rem]">
      {isCoaching ? (
        <span className="text-xs text-neutral-600 italic">Coach is thinking…</span>
      ) : coachNote ? (
        <span className="text-sm text-neutral-400 italic">"{coachNote}"</span>
      ) : null}
    </div>
  )
}
