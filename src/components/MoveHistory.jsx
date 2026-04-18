import { useEffect, useRef } from 'react'

export default function MoveHistory({ moveHistory }) {
  const bottomRef = useRef(null)

  // Auto-scroll to latest move
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [moveHistory])

  if (moveHistory.length === 0) {
    return (
      <div className="text-center text-neutral-600 text-sm py-4 italic">
        No moves yet
      </div>
    )
  }

  // Pair up moves: index 0 = white's move, index 1 = black's move
  const pairs = []
  for (let i = 0; i < moveHistory.length; i += 2) {
    pairs.push({
      number: Math.floor(i / 2) + 1,
      white:  moveHistory[i],
      black:  moveHistory[i + 1] ?? null,
    })
  }

  return (
    <div className="overflow-y-auto max-h-64 pr-1">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-neutral-600 text-xs uppercase tracking-widest">
            <th className="text-left py-1 w-8">#</th>
            <th className="text-left py-1">Theo</th>
            <th className="text-left py-1">Tiggs</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map(({ number, white, black }) => (
            <tr
              key={number}
              className={`border-t border-[#1e1e1e] ${
                number === pairs.length ? 'text-[#D4A017]' : 'text-neutral-400'
              }`}
            >
              <td className="py-1 text-neutral-600">{number}.</td>
              <td className="py-1 font-mono">{white?.san ?? ''}</td>
              <td className="py-1 font-mono">{black?.san ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div ref={bottomRef} />
    </div>
  )
}
