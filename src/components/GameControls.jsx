const TIME_LABELS = {
  casual:  'Casual (no clock)',
  rapid:   'Rapid  · 10 min',
  blitz:   'Blitz  · 5 min',
  bullet:  'Bullet · 3 min',
}

function formatTime(seconds) {
  if (seconds === null) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function TimerBlock({ label, seconds, active, lost }) {
  const urgent = seconds !== null && seconds <= 30
  return (
    <div
      className={`
        flex-1 rounded-lg px-3 py-2 border text-center transition-all
        ${active
          ? 'border-[#D4A017] bg-[#1a1400]'
          : 'border-[#2a2a2a] bg-[#111]'}
        ${lost ? 'opacity-50' : ''}
      `}
    >
      <div className="text-xs text-neutral-500 font-medium uppercase tracking-widest mb-0.5">
        {label}
      </div>
      <div
        className={`text-xl font-mono font-semibold tabular-nums ${
          urgent && active ? 'text-red-400' : active ? 'text-[#D4A017]' : 'text-neutral-400'
        }`}
      >
        {formatTime(seconds)}
      </div>
    </div>
  )
}

export default function GameControls({
  gameStatus,
  turn,
  timeControl,
  whiteTime,
  blackTime,
  performanceScore,
  onNewGame,
  onResign,
}) {
  const isPlaying = gameStatus === 'playing'
  const showClocks = timeControl !== 'casual' && (whiteTime !== null || blackTime !== null)

  // Tiggs is black (turn === 'b'), Theo is white (turn === 'w')
  const theoActive  = turn === 'w'
  const tiggsActive = turn === 'b'

  function handleNewGame(e) {
    e.preventDefault()
    const form = e.currentTarget
    const tc   = form.elements['tc'].value
    onNewGame(tc)
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Clocks — only shown when a time control is active */}
      {showClocks && (
        <div className="flex gap-2">
          <TimerBlock
            label="Theo"
            seconds={whiteTime}
            active={theoActive && isPlaying}
            lost={whiteTime === 0}
          />
          <TimerBlock
            label="Tiggs"
            seconds={blackTime}
            active={tiggsActive && isPlaying}
            lost={blackTime === 0}
          />
        </div>
      )}

      {/* New game form */}
      <form onSubmit={handleNewGame} className="flex flex-col gap-3">
        <label className="text-xs text-neutral-500 uppercase tracking-widest font-medium">
          Time control
        </label>
        <select
          name="tc"
          defaultValue="casual"
          className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3 py-2
                     text-neutral-300 text-sm focus:outline-none focus:border-[#D4A017]
                     cursor-pointer"
        >
          {Object.entries(TIME_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>

        <button
          type="submit"
          className="w-full rounded-lg py-2.5 font-semibold text-sm tracking-wide transition-all
                     bg-[#D4A017] text-black hover:bg-[#e8b520] active:scale-95"
        >
          {gameStatus === 'idle' ? 'Start Game' : 'New Game'}
        </button>
      </form>

      {/* Resign — only during active game */}
      {isPlaying && (
        <button
          onClick={onResign}
          className="w-full rounded-lg py-2 text-sm font-medium text-neutral-500
                     border border-[#2a2a2a] hover:border-red-900 hover:text-red-400
                     transition-all active:scale-95"
        >
          Resign
        </button>
      )}
    </div>
  )
}
