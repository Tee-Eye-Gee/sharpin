import { useState, useEffect, useCallback, useRef } from 'react'
import { usePuzzleEngine } from './hooks/usePuzzleEngine'
import { GUEST_IDENTITY, adoptLegacyDataIfSafe, getPreferences, updatePreferences, syncPreferences, pullRemoteAttempts, flushUnsyncedAttempts, pullProfileStats, hasLocalProfile } from './utils/storage'
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
  // Backlog #1d readiness gate for usePuzzleEngine: the identity whose local
  // profile is ready to drive puzzle selection and rating math, or null
  // while none is. Guest: set by the boot sequence once adoption has
  // finished, and again after logout. Account: set only once a sync has
  // brought that account's stats down (see confirmAccountReady below).
  // Declared before usePuzzleEngine() because it's that hook's input; the
  // hook no longer depends on effect registration order at all.
  const [readyIdentity, setReadyIdentity] = useState(null)

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
  } = usePuzzleEngine({ readyIdentity })

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

  // 'disabled' (feature-flag off) is a distinct terminal state from
  // 'checking' -- initialized directly from the flag, never transitioned
  // into/out of, so it's honest about nothing being "in progress" when the
  // flag is off (rather than parking at 'checking' forever). LaunchOverlay's
  // render condition below only ever matches 'none', so 'disabled' keeps it
  // unmounted the same way 'checking' does. Resolved by the boot effect
  // below, which is no longer independent of the preferences load (see that
  // effect's own comment for why, since storage partitioning).
  const [sessionStatus, setSessionStatus] = useState(ACCOUNT_SYNC_ENABLED ? 'checking' : 'disabled') // 'checking' | 'valid' | 'none' | 'disabled'
  const [session, setSession] = useState(null)
  // Guest tapped "Play as Guest" this page load -- keeps the overlay closed
  // even though sessionStatus stays 'none' (Guest never establishes a
  // session). Reset only by a fresh page load, same as sessionStatus itself.
  const [launchDismissed, setLaunchDismissed] = useState(false)
  // The logged-in profile's display_name (spec:
  // docs/specs/Sharpin_Spec_ProfileDisplayName.md) -- null covers both "not
  // logged in yet" and "logged in, no name set", which is fine since
  // SettingsPanel's Profile section only renders once sessionStatus is
  // 'valid' anyway.
  const [displayName, setDisplayName] = useState(null)

  // Shared between the boot effect below and handleLogout (docs/specs/
  // logout-investigation.md §2's "logout must explicitly reload preferences
  // for the newly-resolved identity" requirement) -- extracted so the two
  // call sites can't silently drift apart. Auto-resolves identity via
  // getPreferences()/updatePreferences()'s own resolveIdentity() call, same
  // as the original boot-only version always did; correct for logout too
  // because it's only ever called AFTER supabase.auth.signOut() has already
  // resolved, by which point resolveIdentity() genuinely sees no session.
  const loadAndApplyPreferences = useCallback(async () => {
    const prefs = await getPreferences()
    let mode = prefs.appMode
    if (mode === null) {
      mode = detectSystemAppMode()
      // updatePreferences, not savePreferences -- this is a genuine
      // system-facing preference write (not pullRemoteAttempts' own
      // watermark bookkeeping), so it should push like any other, per
      // theme-preferences-sync-investigation.md's write-path enumeration.
      await updatePreferences({ appMode: mode })
    }
    setAppMode(mode)
    setBoardTheme(prefs.boardTheme)
    setInputMode(prefs.inputMode)
    applyTheme(mode, prefs.boardTheme)
  }, [])

  // Boot-time session check, legacy-data adoption, and preferences load --
  // deliberately ONE ordered sequence, not three independent effects racing
  // each other. Storage partitioning
  // (docs/specs/storage-partitioning-investigation.md, addenda 2-4) requires
  // adoptLegacyDataIfSafe to run, and finish, before ANY other identity-
  // scoped read this boot -- an early getPreferences() (or usePuzzleEngine's
  // own getProfile()) racing ahead of adoption would see defaults from a
  // not-yet-adopted legacy record, and nothing re-reads afterward to
  // self-correct within the same page load. The three steps below are
  // therefore awaited in sequence inside one async function, not split back
  // into separate effects: (1) resolve session -- flag off means GUEST_
  // IDENTITY immediately, no getSession() call at all, same "zero Supabase
  // traffic" invariant as before; (2) adopt legacy data into whichever
  // identity that resolved to, BEFORE sessionStatus is ever set away from
  // 'checking' -- so every other effect keyed off sessionStatus (the
  // sync-trigger effects below, and any future identity-scoped read) is
  // structurally guaranteed to only ever see a post-adoption world; (3) load
  // preferences, now safe to read under the resolved (and, if applicable,
  // just-adopted) identity.
  //
  // Runs via an empty-dependency useEffect -- fires exactly once for the
  // lifetime of this component. This is load-bearing for
  // adoptLegacyDataIfSafe's own "once per real page mount" guarantee
  // (CLAUDE.md, storage-partitioning section): Logout (below) is a plain
  // in-memory state reset, NOT a remount -- main.jsx renders <App/> once,
  // unconditionally, with no `key`, so nothing in this component's
  // lifetime ever causes React to unmount/remount it. Confirmed concretely
  // before Logout was built (docs/specs/logout-investigation.md Gate Step
  // 0), not assumed: this effect cannot re-fire as a side effect of
  // logging out, however many guest/account transitions happen afterward
  // in the same tab.
  useEffect(() => {
    let cancelled = false

    async function boot() {
      let identity
      if (!ACCOUNT_SYNC_ENABLED) {
        identity = GUEST_IDENTITY
      } else {
        const { data } = await supabase.auth.getSession()
        if (cancelled) return
        identity = data.session ? data.session.user.id : GUEST_IDENTITY
        if (data.session) setSession(data.session)
      }

      // See adoptLegacyDataIfSafe's own doc comment (storage.js) for the
      // guest-vs-stranded-account disambiguation this performs when
      // identity === GUEST_IDENTITY. Never called speculatively during a
      // still-in-flight resolution -- by this point in `boot()`, resolution
      // has already genuinely completed, one way or the other.
      await adoptLegacyDataIfSafe(identity)
      if (cancelled) return

      setSessionStatus(!ACCOUNT_SYNC_ENABLED ? 'disabled' : identity === GUEST_IDENTITY ? 'none' : 'valid')
      // Backlog #1d: the guest's profile is final the moment adoption has
      // returned, so the first puzzle can't be chosen from a defaulted
      // profile (Race A) or committed against one (Race B). An account
      // isn't ready yet -- its stats pull hasn't run; the login-trigger
      // effect below marks it ready.
      if (identity === GUEST_IDENTITY) setReadyIdentity(GUEST_IDENTITY)

      await loadAndApplyPreferences()
    }

    boot()
    return () => { cancelled = true }
  }, [loadAndApplyPreferences])

  // Fetches the logged-in profile's display_name once a real session
  // exists -- piggybacks on the session's own user id rather than a
  // separate lookup call. Re-runs if `session` itself changes (e.g. a
  // fresh Create Account/Login after this component's already mounted),
  // not just on the sessionStatus transition, so a later login within the
  // same page load still picks up the right row.
  useEffect(() => {
    if (sessionStatus !== 'valid' || !session) return
    let cancelled = false
    supabase
      .from('profiles')
      .select('display_name')
      .eq('id', session.user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return
        if (!error) setDisplayName(data.display_name)
      })
    return () => { cancelled = true }
  }, [sessionStatus, session])

  // Ongoing sync (backlog #1 continuation, Commit 4): pull -> flush -> recompute,
  // run on both login and foreground/resume. A ref-based lock, not just the
  // event semantics below, is what actually prevents a double-run if both
  // triggers land close together (e.g. the boot session-restore resolving
  // right as a visibilitychange fires) -- relying solely on "visibilitychange
  // doesn't fire on initial mount" would be correct in the common case but
  // isn't guaranteed across every browser/bfcache-restore scenario, so the
  // lock is the real guarantee, not an assumption.
  //
  // Backlog #1d: a trigger that lands while a run is in flight no longer
  // just returns -- it queues ONE follow-up run (shared by every caller that
  // arrives during the same in-flight run) and gets that run's result. A
  // login right after a logout can land while the previous identity's
  // sequence is still running; skipping would leave the new account's
  // stats unpulled and its puzzle board waiting on readiness indefinitely.
  // Runs are still never concurrent. Resolves to `{ profileStats }`
  // (pullProfileStats' own result) or null if the sequence threw.
  const syncInFlightRef = useRef(null)
  const syncQueuedRef = useRef(null)

  const runSyncSequence = useCallback(function runSync() {
    if (!ACCOUNT_SYNC_ENABLED) return Promise.resolve(null)
    if (syncInFlightRef.current) {
      if (!syncQueuedRef.current) {
        syncQueuedRef.current = syncInFlightRef.current.then(() => {
          syncQueuedRef.current = null
          return runSync()
        })
      }
      return syncQueuedRef.current
    }
    const sequence = runSyncSteps()
    syncInFlightRef.current = sequence
    // Registered before any queued follow-up's own .then (above), so the
    // lock is already released by the time that follow-up starts.
    sequence.then(() => { syncInFlightRef.current = null })
    return sequence
  }, [])

  async function runSyncSteps() {
    try {
      await pullRemoteAttempts()
      await flushUnsyncedAttempts()
      await supabase.rpc('recompute_stats')
      // Backlog #1g (docs/specs/guest-merge-profile-migration-investigation.md):
      // pulls the local profile/themeStats aggregate down from what
      // recompute_stats() just computed server-side -- the missing
      // counterpart to attempts' own pullRemoteAttempts above. Placed right
      // after recompute_stats() so the server-side values it reads are
      // guaranteed fresh for this call. Covers both reachable paths: an
      // ordinary Login (this effect's own login-trigger condition below)
      // and guest-to-account Merge (onAuthenticated's setSessionStatus('valid')
      // call causes this same effect to fire next render -- no separate call
      // needed inside migrateGuestDataToAccount).
      const profileStats = await pullProfileStats()
      // Preferences' own sync step, riding this same mutex-guarded
      // login/foreground sequence -- deliberately NOT part of the three
      // attempts steps above (independent store, independent branch logic:
      // push-if-unsynced/else-pull-if-newer, not a fixed pull-then-push --
      // see syncPreferences' own doc comment in storage.js for why that
      // ordering differs from attempts' and must not be copied).
      await syncPreferences()
      return { profileStats }
    } catch {
      // Best-effort background sync -- must never surface to the user or
      // block puzzle-board interaction. The next login/foreground trigger
      // retries the whole sequence from scratch.
      return null
    }
  }

  // Backlog #1d: whether `uid`'s local profile can now drive puzzle
  // selection and rating math, given a finished sync's result. Ready if
  // that sync's stats pull succeeded for this same uid. If it couldn't
  // (offline, a query error, the sequence threw), fall back to this
  // device's own stored record for uid when one exists -- the same profile
  // offline play has always used. With no record at all, DEFAULT_PROFILE
  // would only be a guess at an account that may have real history, so it
  // stays not-ready until a later (foreground) sync gets through.
  const confirmAccountReady = useCallback(async (uid, result) => {
    if (result?.profileStats?.ok && result.profileStats.identity === uid) return true
    return hasLocalProfile(uid)
  }, [])

  // Login trigger: fires whenever sessionStatus transitions to 'valid' --
  // covers BOTH the boot-time session-restore effect above (an existing
  // session found on load, which includes any session a recovery link
  // establishes on page load) and an interactive Login/Create Account
  // within this same page load (onAuthenticated below), since both paths
  // funnel through the same setSessionStatus('valid') call. This is
  // deliberately the same trigger condition as the displayName-fetch effect
  // above. Also the account half of #1d's readiness gate: readiness drops
  // to null the moment the active user changes (usePuzzleEngine discards
  // the outgoing user's puzzle), and comes back as this uid only after this
  // sync has pulled its stats down.
  useEffect(() => {
    if (sessionStatus !== 'valid' || !session) return
    const uid = session.user.id
    let cancelled = false
    setReadyIdentity((prev) => (prev === uid ? prev : null))
    runSyncSequence().then(async (result) => {
      if (cancelled) return
      if (await confirmAccountReady(uid, result) && !cancelled) setReadyIdentity(uid)
    })
    return () => { cancelled = true }
  }, [sessionStatus, session, runSyncSequence, confirmAccountReady])

  // Foreground/resume trigger: Page Visibility API, not a continuous poll.
  // visibilitychange only fires on an actual state transition, never for
  // the tab's initial state at mount -- so on a normal first load this
  // effect registers a listener but does not itself invoke runSyncSequence,
  // leaving the login trigger above as the sole first-load trigger (the
  // syncInFlightRef lock above is the actual backstop against any
  // browser-specific exception to that).
  // Also retries readiness: if the login-time sync couldn't confirm this
  // account's stats, a later foreground sync that does marks it ready.
  useEffect(() => {
    if (sessionStatus !== 'valid' || !session) return
    const uid = session.user.id
    let cancelled = false
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      runSyncSequence().then(async (result) => {
        if (cancelled) return
        if (await confirmAccountReady(uid, result) && !cancelled) setReadyIdentity(uid)
      })
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [sessionStatus, session, runSyncSequence, confirmAccountReady])

  const toggleAppMode = useCallback(() => {
    setAppMode((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      applyTheme(next, boardTheme)
      updatePreferences({ appMode: next })
      return next
    })
  }, [boardTheme])

  const selectBoardTheme = useCallback((themeId) => {
    setBoardTheme(themeId)
    applyTheme(appMode, themeId)
    updatePreferences({ boardTheme: themeId })
  }, [appMode])

  const selectInputMode = useCallback((mode) => {
    setInputMode(mode)
    updatePreferences({ inputMode: mode })
  }, [])

  // Calls update-profile (server-side is the actual enforcement point for
  // the spec's validation rules -- SettingsPanel's own client-side check is
  // just immediate feedback, same two-layer design as Create Account).
  // Returns { ok, error? } rather than throwing so SettingsPanel can show
  // the specific rejection reason inline instead of a generic failure.
  const saveDisplayName = useCallback(async (newName) => {
    const { data, error } = await supabase.functions.invoke('update-profile', {
      body: { displayName: newName },
    })
    if (error) {
      const message = error.context?.status === 400
        ? (await error.context.json().catch(() => null))?.error
        : null
      return { ok: false, error: message ?? 'Something went wrong -- try again.' }
    }
    setDisplayName(data.displayName)
    return { ok: true }
  }, [])

  // Logout (backlog #2, docs/specs/logout-investigation.md). A plain
  // in-memory state reset -- NOT a page reload -- per Gate Step 0's
  // decision, documented above the boot effect and in CLAUDE.md.
  //
  // Safe to call with a push/pull genuinely in flight; no flush-before-
  // logout step is needed. `signOut()` clears the real session
  // immediately, so any push/pull step that reads `getSession()`
  // afterward sees no session and no-ops via its own existing guard.
  // Anything that already read a session before `signOut()` ran is
  // covered by the identity-pinned guards (#1e/#1f, live-verified): a
  // push either completes correctly under its original, already-pinned
  // identity or aborts cleanly on a mismatch -- it can never corrupt
  // whichever account becomes active next.
  //
  // "Logout" and "switch to guest mode" are the same end state (per the
  // investigation's own finding, since storage partitioning makes the
  // guest namespace structurally unable to contain a different account's
  // data) -- this just returns to the launch screen; Play as Guest from
  // there is the exact same path a fresh boot-with-no-session already
  // takes, nothing separate to build.
  //
  // Closes the Settings panel explicitly -- found via real-DOM
  // verification, not something the investigation's own analysis
  // surfaced: `settingsOpen` isn't touched by anything else here, so
  // without this line, logging out while Settings is open leaves it
  // rendered behind the now-reappeared LaunchOverlay (both are
  // independent `fixed inset-0` overlays), stacking two full-screen
  // backdrops/cards at once instead of cleanly returning to the launch
  // screen alone.
  //
  // Backlog #1d: readiness drops to null first, so usePuzzleEngine discards
  // the account's puzzle before the session goes away, and comes back as
  // GUEST_IDENTITY only after signOut() has resolved -- by then storage's
  // live identity is the guest too, so the guest's first puzzle and its
  // commit both resolve against the guest profile. Analyze mode is exited
  // because the discarded puzzle was what it was analyzing.
  const handleLogout = useCallback(async () => {
    setReadyIdentity(null)
    setAnalyzeMode(false)
    await supabase.auth.signOut()
    setReadyIdentity(GUEST_IDENTITY)
    setSession(null)
    setSessionStatus('none')
    setDisplayName(null)
    setLaunchDismissed(false)
    setSettingsOpen(false)
    await loadAndApplyPreferences()
  }, [loadAndApplyPreferences])

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
          boardTheme={boardTheme}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          boardTheme={boardTheme}
          onSelectBoardTheme={selectBoardTheme}
          inputMode={inputMode}
          onSelectInputMode={selectInputMode}
          onClose={() => setSettingsOpen(false)}
          loggedIn={sessionStatus === 'valid'}
          displayName={displayName}
          onSaveDisplayName={saveDisplayName}
          onLogout={handleLogout}
          logoutDisabled={puzzleAttemptInFlight}
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
