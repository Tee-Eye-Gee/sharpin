import { useState, useEffect, useCallback } from 'react'
import { usePuzzleEngine } from './hooks/usePuzzleEngine'
import { getPreferences, savePreferences } from './utils/storage'
import { detectSystemAppMode, applyTheme, DEFAULT_BOARD_THEME } from './utils/theme'
import Header          from './components/Header'
import SettingsPanel    from './components/SettingsPanel'
import Board            from './components/Board'
import PuzzleControls   from './components/PuzzleControls'
import ProgressPanel    from './components/ProgressPanel'
import CoachNote        from './components/CoachNote'
import AnalyzePanel     from './components/AnalyzePanel'

const HEADLINES = {
  loading: 'Loading puzzle…',
  solving: 'Find the best move',
  correct: 'Correct — keep going',
  failed: 'Not quite',
  error: 'No puzzles available',
}

export default function App() {
  const {
    fen,
    puzzleStartFen,
    orientation,
    status,
    userRating,
    lastDelta,
    streak,
    currentThemes,
    puzzleRating,
    coachNote,
    lastMove,
    isRetrying,
    hintPieceSquare,
    hintDestSquare,
    hintUsedThisAttempt,
    onUserMove,
    loadNextPuzzle,
    pressHint,
    retryPuzzle,
  } = usePuzzleEngine()

  const [appMode, setAppMode] = useState('dark')
  const [boardTheme, setBoardTheme] = useState(DEFAULT_BOARD_THEME)
  const [inputMode, setInputMode] = useState('drag')
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Analyze mode is a full replacement of the puzzle-solving board+controls
  // layout below, not an overlay alongside it (spec
  // Sharpin_Spec_AnalyzeMode.md §4) -- only ever set true via the Analyze
  // button (itself only shown when status === 'solved'), false via Exit.
  // AnalyzePanel owns all of its own state locally and unmounting it (this
  // flag flipping back to false) is the entire cleanup, so no other
  // transition needs to touch this.
  const [analyzeMode, setAnalyzeMode] = useState(false)

  // On first mount: load persisted preferences. If app mode has never been
  // set, detect it from the OS once and persist that as the permanent
  // choice — subsequent visits must not re-detect (spec §3).
  useEffect(() => {
    let cancelled = false
    getPreferences().then(async (prefs) => {
      if (cancelled) return
      let mode = prefs.appMode
      if (mode === null) {
        mode = detectSystemAppMode()
        await savePreferences({ ...prefs, appMode: mode })
      }
      setAppMode(mode)
      setBoardTheme(prefs.boardTheme)
      setInputMode(prefs.inputMode)
      applyTheme(mode, prefs.boardTheme)
    })
    return () => { cancelled = true }
  }, [])

  const toggleAppMode = useCallback(() => {
    setAppMode((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      applyTheme(next, boardTheme)
      getPreferences().then((prefs) => savePreferences({ ...prefs, appMode: next }))
      return next
    })
  }, [boardTheme])

  const selectBoardTheme = useCallback((themeId) => {
    setBoardTheme(themeId)
    applyTheme(appMode, themeId)
    getPreferences().then((prefs) => savePreferences({ ...prefs, boardTheme: themeId }))
  }, [appMode])

  const selectInputMode = useCallback((mode) => {
    setInputMode(mode)
    getPreferences().then((prefs) => savePreferences({ ...prefs, inputMode: mode }))
  }, [])

  return (
    <div className="min-h-screen bg-bg text-fg flex flex-col">

      <Header
        appMode={appMode}
        onToggleMode={toggleAppMode}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {settingsOpen && (
        <SettingsPanel
          boardTheme={boardTheme}
          onSelectBoardTheme={selectBoardTheme}
          inputMode={inputMode}
          onSelectInputMode={selectInputMode}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <main className="flex-1 flex flex-col md:flex-row gap-0 md:gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
        {analyzeMode ? (
          <AnalyzePanel
            startFen={puzzleStartFen}
            orientation={orientation}
            boardTheme={boardTheme}
            appMode={appMode}
            inputMode={inputMode}
            onExit={() => setAnalyzeMode(false)}
          />
        ) : (
          <>
            <div className="flex flex-col gap-3 w-full md:max-w-[520px]">
              <div className="flex items-center justify-between">
                <p className="text-xs text-fg-muted">
                  {orientation === 'white' ? 'You are White' : 'You are Black'}
                </p>
                <div
                  className={
                    status === 'solved'
                      ? 'text-xs font-medium px-2.5 py-1 rounded-full bg-accent/10 text-accent border border-accent/40 flex items-center gap-1'
                      : 'text-xs font-medium px-2.5 py-1 rounded-full bg-surface text-fg-muted border border-border'
                  }
                >
                  {status === 'solved' ? (
                    <>
                      <span aria-hidden="true">✓</span> {hintUsedThisAttempt ? 'Solved - hint used' : 'Solved'}
                    </>
                  ) : (
                    HEADLINES[status] ?? ''
                  )}
                </div>
              </div>

              <Board
                fen={fen}
                orientation={orientation}
                status={status}
                lastMove={lastMove}
                hintPieceSquare={hintPieceSquare}
                hintDestSquare={hintDestSquare}
                onUserMove={onUserMove}
                boardTheme={boardTheme}
                appMode={appMode}
                inputMode={inputMode}
              />
              <CoachNote status={status} coachNote={coachNote} />
            </div>

            <aside className="flex flex-col gap-4 w-full md:w-64 lg:w-72 flex-shrink-0 mt-4 md:mt-0">
              <div className="bg-surface border border-border rounded-lg p-4">
                <PuzzleControls
                  status={status}
                  puzzleRating={puzzleRating}
                  currentThemes={currentThemes}
                  isRetrying={isRetrying}
                  onNextPuzzle={loadNextPuzzle}
                  onHint={pressHint}
                  onRetry={retryPuzzle}
                  onAnalyze={() => setAnalyzeMode(true)}
                />
              </div>

              <div className="bg-surface border border-border rounded-lg p-4">
                <ProgressPanel
                  userRating={userRating}
                  lastDelta={lastDelta}
                  streak={streak}
                  refreshKey={status}
                />
              </div>
            </aside>
          </>
        )}
      </main>
    </div>
  )
}
