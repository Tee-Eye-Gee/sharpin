import { useEffect, useState } from 'react'
import { getWeakThemes } from '../utils/storage'

export default function ProgressPanel({ userRating, lastDelta, streak, refreshKey }) {
  const [weakThemes, setWeakThemes] = useState([])

  useEffect(() => {
    let cancelled = false
    getWeakThemes().then((ranked) => {
      if (!cancelled) setWeakThemes(ranked)
    })
    return () => { cancelled = true }
  }, [refreshKey])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xs text-neutral-600 uppercase tracking-widest font-medium mb-2">
          Rating
        </h2>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-[#D4A017] font-mono tabular-nums">
            {userRating ?? '—'}
          </span>
          {lastDelta !== 0 && (
            <span className={`text-xs font-mono ${lastDelta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {lastDelta > 0 ? '+' : ''}{lastDelta}
            </span>
          )}
        </div>
      </div>

      {streak > 0 && (
        <div>
          <h2 className="text-xs text-neutral-600 uppercase tracking-widest font-medium mb-1">
            Streak
          </h2>
          <span className="text-sm text-neutral-300 font-medium">{streak} in a row</span>
        </div>
      )}

      {weakThemes.length > 0 && (
        <div>
          <h2 className="text-xs text-neutral-600 uppercase tracking-widest font-medium mb-2">
            Needs work
          </h2>
          <ul className="flex flex-col gap-1.5">
            {weakThemes.map(({ theme, accuracy, attempts }) => (
              <li key={theme} className="flex items-center justify-between text-sm">
                <span className="text-neutral-400">{theme}</span>
                <span className="text-neutral-600 font-mono text-xs">
                  {Math.round(accuracy * 100)}% ({attempts})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
