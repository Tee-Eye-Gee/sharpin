import { usePuzzleEngine } from './hooks/usePuzzleEngine'
import Board           from './components/Board'
import PuzzleControls  from './components/PuzzleControls'
import ProgressPanel   from './components/ProgressPanel'
import CoachNote        from './components/CoachNote'

const HEADLINES = {
  loading: 'Loading puzzle…',
  solving: 'Find the best move',
  correct: 'Correct — keep going',
  solved: 'Solved!',
  failed: 'Not quite',
  error: 'No puzzles available',
}

export default function App() {
  const {
    fen,
    orientation,
    status,
    userRating,
    lastDelta,
    streak,
    currentThemes,
    puzzleRating,
    coachNote,
    lastMove,
    onUserMove,
    loadNextPuzzle,
    giveUp,
  } = usePuzzleEngine()

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-neutral-200 flex flex-col">

      <header className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
        <div>
          <h1 className="text-lg font-bold tracking-tight">
            <span className="text-[#D4A017]">Sharp</span>
            <span>in</span>
          </h1>
          <p className="text-xs text-neutral-600">
            {orientation === 'white' ? 'You are White' : 'You are Black'}
          </p>
        </div>

        <div className="text-xs font-medium px-2.5 py-1 rounded-full bg-[#1a1a1a] text-neutral-500 border border-[#2a2a2a]">
          {HEADLINES[status] ?? ''}
        </div>
      </header>

      <main className="flex-1 flex flex-col md:flex-row gap-0 md:gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">

        <div className="flex flex-col gap-3 w-full md:max-w-[520px]">
          <Board
            fen={fen}
            orientation={orientation}
            status={status}
            lastMove={lastMove}
            onUserMove={onUserMove}
          />
          <CoachNote status={status} coachNote={coachNote} />
        </div>

        <aside className="flex flex-col gap-4 w-full md:w-64 lg:w-72 flex-shrink-0 mt-4 md:mt-0">
          <div className="bg-[#141414] border border-[#1e1e1e] rounded-lg p-4">
            <PuzzleControls
              status={status}
              puzzleRating={puzzleRating}
              currentThemes={currentThemes}
              onNextPuzzle={loadNextPuzzle}
              onGiveUp={giveUp}
            />
          </div>

          <div className="bg-[#141414] border border-[#1e1e1e] rounded-lg p-4">
            <ProgressPanel
              userRating={userRating}
              lastDelta={lastDelta}
              streak={streak}
              refreshKey={status}
            />
          </div>
        </aside>
      </main>
    </div>
  )
}
