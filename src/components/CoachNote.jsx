export default function CoachNote({ status, coachNote }) {
  if (status !== 'solved' && status !== 'failed') return null
  if (!coachNote) return null

  return (
    <div className="px-1 min-h-[1.5rem]">
      <span className="text-sm text-fg-muted italic">"{coachNote}"</span>
    </div>
  )
}
