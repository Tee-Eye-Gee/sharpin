import { useMemo } from 'react'
import { useGameEngine } from './hooks/useGameEngine'
import Board         from './components/Board'
import GameControls  from './components/GameControls'
import MoveHistory   from './components/MoveHistory'
import StatusBar     from './components/StatusBar'

export default function App() {
  const {
    fen,
    gameStatus,
    gameResult,
    turn,
    performanceScore,
    moveHistory,
    theoComment,
    isTheoThinking,
    timeControl,
    whiteTime,
    blackTime,
    onTiggsMoved,
    startNewGame,
    resign,
  } = useGameEngine()

  // Track last move for board highlighting
  const lastMove = useMemo(() => {
    if (moveHistory.length === 0) return null
    // We stored SAN, not from/to — board highlight needs from/to.
    // react-chessboard handles last-move highlight natively if we pass
    // customSquareStyles, but we don't store from/to in history.
    // For now, return null (highlighting is a nice-to-have).
    return null
  }, [moveHistory])

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-neutral-200 flex flex-col">

      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
        <div>
          <h1 className="text-lg font-bold tracking-tight">
            <span className="text-[#D4A017]">Theo</span>
            <span className="text-neutral-500 mx-1.5">v.</span>
            <span>Tiggs</span>
          </h1>
          <p className="text-xs text-neutral-600">You are Black</p>
        </div>

        {/* Status summary on mobile header */}
        {gameStatus === 'playing' && (
          <div className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            turn === 'b' && !isTheoThinking
              ? 'bg-[#1a1400] text-[#D4A017] border border-[#D4A017]/40'
              : 'bg-[#1a1a1a] text-neutral-500 border border-[#2a2a2a]'
          }`}>
            {turn === 'b' && !isTheoThinking ? 'Your move' : 'Theo…'}
          </div>
        )}
      </header>

      {/* Main layout — stacks vertically on mobile, side-by-side on md+ */}
      <main className="flex-1 flex flex-col md:flex-row gap-0 md:gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">

        {/* Board column */}
        <div className="flex flex-col gap-3 w-full md:max-w-[520px]">
          <Board
            fen={fen}
            onTiggsMoved={onTiggsMoved}
            isTheoThinking={isTheoThinking}
            gameStatus={gameStatus}
            lastMove={lastMove}
          />

          {/* Status bar sits directly below board */}
          <div className="bg-[#141414] border border-[#1e1e1e] rounded-lg px-3 py-2.5">
            <StatusBar
              gameStatus={gameStatus}
              gameResult={gameResult}
              turn={turn}
              isTheoThinking={isTheoThinking}
              theoComment={theoComment}
              performanceScore={performanceScore}
            />
          </div>
        </div>

        {/* Sidebar: controls + history */}
        <aside className="flex flex-col gap-4 w-full md:w-64 lg:w-72 flex-shrink-0 mt-4 md:mt-0">

          <div className="bg-[#141414] border border-[#1e1e1e] rounded-lg p-4">
            <GameControls
              gameStatus={gameStatus}
              turn={turn}
              timeControl={timeControl}
              whiteTime={whiteTime}
              blackTime={blackTime}
              performanceScore={performanceScore}
              onNewGame={startNewGame}
              onResign={resign}
            />
          </div>

          <div className="bg-[#141414] border border-[#1e1e1e] rounded-lg p-4">
            <h2 className="text-xs text-neutral-600 uppercase tracking-widest font-medium mb-3">
              Moves
            </h2>
            <MoveHistory moveHistory={moveHistory} />
          </div>

        </aside>
      </main>
    </div>
  )
}
