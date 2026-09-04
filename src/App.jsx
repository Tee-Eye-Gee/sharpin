import { useState, useEffect, useCallback } from 'react'
import { usePuzzleEngine } from './hooks/usePuzzleEngine'
import { getPreferences, savePreferences } from './utils/storage'
import { detectSystemAppMode, applyTheme, DEFAULT_BOARD_THEME } from './utils/theme'
import { supabase } from './lib/supabaseClient'
import Header          from './components/Header'
import LaunchOverlay    from './components/LaunchOverlay'
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

// Feature flag gating all of Stage 3's account/sync UI (backlog #1).
// Default OFF: unset, or any value other than the literal string 'true',
// disables it -- matches Vite's own env-var convention (values are always
// strings; there is no boolean coercion). Set VITE_ENABLE_ACCOUNT_SYNC=true
// in .env to enable locally.
const ACCOUNT_SYNC_ENABLED = import.meta.env.VITE_ENABLE_ACCOUNT_SYNC === 'true'

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
    attemptStarted,
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

  // Boot-time session check (Sub-build B1). Independent of the puzzle-load
  // and preferences-load effects below -- runs in parallel, does not gate
  // or delay either of them. 'disabled' (feature-flag off) is a distinct
  // terminal state from 'checking' -- initialized directly from the flag,
  // never transitioned into/out of, so it's honest about nothing being "in
  // progress" when the flag is off (rather than parking at 'checking'
  // forever). LaunchOverlay's render condition below only ever matches
  // 'none', so 'disabled' keeps it unmounted the same way 'checking' does.
  const [sessionStatus, setSessionStatus] = useState(ACCOUNT_SYNC_ENABLED ? 'checking' : 'disabled') // 'checking' | 'valid' | 'none' | 'disabled'
  const [session, setSession] = useState(null)
  // Guest tapped "Play as Guest" this page load -- keeps the overlay closed
  // even though sessionStatus stays 'none' (Guest never establishes a
  // session). Reset only by a fresh page load, same as sessionStatus itself.
  const [launchDismissed, setLaunchDismissed] = useState(false)

  useEffect(() => {
    // Flag off: skip the call entirely -- not just hide its result. Zero
    // Supabase network traffic on boot when Stage 3 is disabled.
    if (!ACCOUNT_SYNC_ENABLED) return

    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      if (data.session) {
        setSession(data.session)
        setSessionStatus('valid')
      } else {
        setSessionStatus('none')
      }
    })
    return () => { cancelled = true }
  }, [])

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

  // Puzzle-in-progress gating (Sub-build B2a, corrected after the deadlock
  // fix below). Login and Create Account are disabled only while a REAL
  // in-flight write is possible -- not merely "a puzzle is loaded" (that
  // first version deadlocked: the overlay's own backdrop blocks all board
  // interaction, so a puzzle that gates from the moment it loads can never
  // reach the commit that would un-gate it). The correct condition is
  // "interaction has started on the current attempt AND it hasn't committed
  // yet" -- a freshly-loaded, zero-interaction puzzle has nothing in flight
  // to protect. `attemptStarted` (usePuzzleEngine.js) is the new signal
  // added for this; `committed` mirrors the same reasoning as before (a
  // commit has always already happened by the time status is
  // 'solved'/'failed', or once hintUsedThisAttempt/isRetrying are true).
  const puzzleAttemptCommitted = status === 'solved' || status === 'failed' || hintUsedThisAttempt || isRetrying
  const puzzleAttemptInFlight = attemptStarted && !puzzleAttemptCommitted

  return (
    <div className="min-h-screen bg-bg text-fg flex flex-col">

      <Header
        appMode={appMode}
        onToggleMode={toggleAppMode}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {sessionStatus === 'none' && !launchDismissed && (
        <LaunchOverlay
          onGuest={() => setLaunchDismissed(true)}
          onAuthenticated={(newSession) => {
            setSession(newSession)
            setSessionStatus('valid')
            setLaunchDismissed(true)
          }}
          actionsDisabled={puzzleAttemptInFlight}
        />
      )}

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
