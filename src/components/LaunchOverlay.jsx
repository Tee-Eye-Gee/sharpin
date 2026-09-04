import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { getAllAttempts, getThemeStats, getProfile, getPreferences, resetAllLocalData } from '../utils/storage'

// TEMPORARY PLACEHOLDER (Sub-build B2a): the real 4-move identity input is a
// board-gesture capture -- drag/tap out 4 arbitrary moves, no chess-legality
// checking -- which is a genuinely new component needing its own dedicated
// design pass (deliberately out of scope here). This plain text/token field
// exists only to unblock Login/Create Account's request plumbing for this
// pass. Swap boundary: `onSequenceComplete(hash)` is the entire contract the
// rest of this file depends on -- the real gesture-capture component can
// replace this one's internals (or the whole component) later without
// touching LaunchOverlay's Login/Create Account handlers, App.jsx, or
// anything else.
async function hashSequence(raw) {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function SequenceInputPlaceholder({ onSequenceComplete, disabled, submitLabel }) {
  const [value, setValue] = useState('')
  const [hashing, setHashing] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!value.trim() || hashing) return
    setHashing(true)
    const hash = await hashSequence(value.trim())
    setHashing(false)
    onSequenceComplete(hash)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled || hashing}
        placeholder="e2e4 e7e5 g1f3 b8c6"
        aria-label="4-move sequence"
        className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || hashing || !value.trim()}
        className="rounded-lg border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-accent transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {hashing ? 'Working…' : submitLabel}
      </button>
    </form>
  )
}

const VIEWS = { MENU: 'menu', LOGIN: 'login', CREATE: 'create', MIGRATION_PROMPT: 'migration_prompt' }

// Guest-to-account migration (Sub-build B2b, spec §5's "Guest -> account
// migration" -- one-time historical transfer at account creation only, NOT
// ongoing sync; no future-attempt push logic here or anywhere yet). Runs
// after Create Account has already minted a real, authenticated session, so
// RLS (profile_id = auth.uid()) is what actually enforces every write below
// can only ever touch this new account's own rows -- these are plain
// supabase-js table calls, no Edge Function, confirmed viable against the
// live RLS policies during the B2b investigation pass.
//
// Write order: puzzle_attempts -> theme_stats -> profile_stats ->
// preferences. Retry-safe by construction, not by assumption:
// theme_stats/profile_stats/preferences are all upserts keyed on their real
// remote PKs (profile_id[,theme]), so re-running them with the same
// locally-sourced values is naturally idempotent. puzzle_attempts has no
// such natural key (a fresh crypto.randomUUID() is generated per row, since
// investigation confirmed nothing else references these ids) -- so a blind
// retry could duplicate rows already landed by an earlier partial attempt.
// The pre-check below (also serving as the locked decision's "confirm the
// empty-remote assumption at runtime" requirement) handles both concerns
// with the same read: if puzzle_attempts already has rows for this
// profile, either this is a resumed retry (skip re-inserting, move on) or
// a genuinely unexpected pre-existing-data edge case (same safe response
// either way -- never append/duplicate).
//
// True multi-table atomicity isn't achievable from separate client-side
// calls without an Edge Function wrapping them in one Postgres transaction
// (out of this pass's file scope) -- if a later step throws, earlier steps
// in *this* call have already committed remotely and are not rolled back.
// "Do not partially commit" is honored in the sense that matters to the
// caller: the UI never reports success on a partial failure, local data is
// never cleared on failure, and retrying is safe (won't duplicate whatever
// already landed) rather than compounding the partial state.
async function migrateGuestDataToAccount(userId) {
  const { count: existingRemoteAttempts, error: existingCheckError } = await supabase
    .from('puzzle_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', userId)

  if (existingCheckError) {
    throw new Error('migration pre-check failed')
  }

  if (!existingRemoteAttempts) {
    const localAttempts = await getAllAttempts()
    if (localAttempts.length > 0) {
      const rows = localAttempts.map((a) => ({
        id: crypto.randomUUID(),
        profile_id: userId,
        puzzle_id: a.puzzleId,
        themes: a.themes,
        solved: a.solved,
        hint_used: a.hintUsed,
        rating_delta: a.ratingDelta,
        time_taken_ms: a.timeTakenMs,
        attempted_at: new Date(a.at).toISOString(),
      }))
      const { error: attemptsError } = await supabase.from('puzzle_attempts').insert(rows)
      if (attemptsError) throw new Error('puzzle_attempts write failed')
    }
  }

  const themeStatsObj = await getThemeStats()
  const themeRows = Object.entries(themeStatsObj).map(([theme, s]) => ({
    profile_id: userId,
    theme,
    attempts: s.attempts,
    solved: s.solved,
  }))
  if (themeRows.length > 0) {
    const { error: themeStatsError } = await supabase
      .from('theme_stats')
      .upsert(themeRows, { onConflict: 'profile_id,theme' })
    if (themeStatsError) throw new Error('theme_stats write failed')
  }

  const profile = await getProfile()
  const { error: profileStatsError } = await supabase.from('profile_stats').upsert(
    {
      profile_id: userId,
      rating: profile.rating,
      current_streak: profile.currentStreak,
      best_streak: profile.bestStreak,
      total_solved: profile.totalSolved,
      total_failed: profile.totalFailed,
    },
    { onConflict: 'profile_id' },
  )
  if (profileStatsError) throw new Error('profile_stats write failed')

  const prefs = await getPreferences()
  const { error: preferencesError } = await supabase.from('preferences').upsert(
    {
      profile_id: userId,
      app_mode: prefs.appMode,
      board_theme: prefs.boardTheme,
      input_mode: prefs.inputMode,
    },
    { onConflict: 'profile_id' },
  )
  if (preferencesError) throw new Error('preferences write failed')
}

/**
 * 3-tier launch overlay (spec §5): Guest (primary) / Create Account
 * (secondary) / Login (tertiary link). Rendered by App.jsx only while
 * sessionStatus === 'none' -- see that condition for the 'checking'/'valid'
 * exclusions.
 *
 * @param {object} props
 * @param {() => void} props.onGuest - Guest tapped; dismiss with no action.
 * @param {(session: object) => void} props.onAuthenticated - a real session
 *   was obtained (Login match, or Create Account success) and setSession()
 *   already succeeded; caller is responsible for closing the overlay.
 * @param {boolean} props.actionsDisabled - true while a puzzle attempt is
 *   in flight (not yet committed) -- Create Account and Login are both
 *   disabled in that case (Guest is never affected). See App.jsx for the
 *   derivation.
 */
export default function LaunchOverlay({ onGuest, onAuthenticated, actionsDisabled }) {
  const [view, setView] = useState(VIEWS.MENU)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [rateLimited, setRateLimited] = useState(false)
  // Session already established (setSession succeeded) but the
  // migration-prompt view hasn't resolved yet -- see handleCreateAccount
  // below.
  const [pendingSession, setPendingSession] = useState(null)
  // Disables both Merge/Discard buttons during their async operation
  // (locked decision: prevent double-submit, same discipline as the
  // concurrency findings from the create-account rate-limit fix earlier
  // this stage) and drives the "Working…" label.
  const [migrating, setMigrating] = useState(false)
  const [migrationError, setMigrationError] = useState('')

  function resetFormState() {
    setError('')
    setRateLimited(false)
  }

  function backToMenu() {
    resetFormState()
    setSubmitting(false)
    setView(VIEWS.MENU)
  }

  async function handleLogin(hash) {
    resetFormState()
    setSubmitting(true)
    const { data, error: invokeError } = await supabase.functions.invoke('verify-move-sequence', {
      body: { moveSequenceHash: hash },
    })
    setSubmitting(false)

    if (invokeError) {
      setError('Something went wrong -- try again.')
      return
    }
    if (!data.match) {
      // Locked decision (spec §5): a no-match result is a plain login
      // failure -- never a fallback into account creation.
      setError('Sequence not recognized -- try again.')
      return
    }

    const { data: setSessionData, error: setSessionError } = await supabase.auth.setSession(data.session)
    if (setSessionError) {
      setError('Something went wrong -- try again.')
      return
    }
    onAuthenticated(setSessionData.session)
  }

  async function handleCreateAccount(hash) {
    resetFormState()
    setSubmitting(true)
    const { data, error: invokeError } = await supabase.functions.invoke('create-account', {
      body: { moveSequenceHash: hash },
    })

    if (invokeError) {
      setSubmitting(false)
      // FunctionsHttpError's `context` is the raw Response -- `.status`
      // distinguishes the three real response shapes confirmed live in
      // Sub-build A (409 collision, 429 rate-limited, anything else a
      // generic failure).
      const status = invokeError.context?.status
      if (status === 409) {
        setError('That sequence is already in use -- choose another.')
      } else if (status === 429) {
        setRateLimited(true)
      } else {
        setError('Something went wrong -- try again.')
      }
      return
    }

    const { data: setSessionData, error: setSessionError } = await supabase.auth.setSession(data.session)
    setSubmitting(false)
    if (setSessionError) {
      setError('Something went wrong -- try again.')
      return
    }

    // Guest-to-account migration (Sub-build B2b) hooks in exactly here:
    // local IndexedDB history existing at this exact moment is what
    // triggers the Merge/Discard prompt (spec §5) rather than a silent
    // decision either way. Uses setSessionData.session (setSession()'s own
    // resolved return value, which includes .user) rather than the raw
    // create-account response (data.session is just
    // { access_token, refresh_token } -- no .user) -- handleMerge below
    // needs pendingSession.user.id, which only the resolved session has.
    const existingAttempts = await getAllAttempts()
    if (existingAttempts.length > 0) {
      setPendingSession(setSessionData.session)
      setView(VIEWS.MIGRATION_PROMPT)
    } else {
      onAuthenticated(setSessionData.session)
    }
  }

  async function handleMerge() {
    setMigrationError('')
    setMigrating(true)
    try {
      await migrateGuestDataToAccount(pendingSession.user.id)
      setMigrating(false)
      onAuthenticated(pendingSession)
    } catch {
      setMigrating(false)
      setMigrationError('Something went wrong bringing over your history -- try again.')
    }
  }

  async function handleDiscard() {
    setMigrationError('')
    setMigrating(true)
    await resetAllLocalData()
    setMigrating(false)
    onAuthenticated(pendingSession)
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" />

      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-xl">
          <h2 className="text-lg font-bold tracking-tight mb-3">
            <span className="text-accent">Sharp</span>
            <span className="text-fg">in</span>
          </h2>

          {view === VIEWS.MENU && (
            <div className="flex flex-col gap-2">
              <button
                onClick={onGuest}
                className="rounded-lg border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-accent transition-all active:scale-95"
              >
                Play as Guest
              </button>

              <button
                onClick={() => setView(VIEWS.CREATE)}
                disabled={actionsDisabled}
                className="rounded-lg border border-border px-3 py-2 text-sm text-fg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Account
              </button>

              {actionsDisabled && (
                <p className="text-xs text-fg-muted text-center">
                  Create Account and Login are available once this puzzle is scored.
                </p>
              )}

              <button
                onClick={() => setView(VIEWS.LOGIN)}
                disabled={actionsDisabled}
                aria-label="Login with an existing account"
                className="text-xs text-fg-muted hover:text-fg underline text-center mt-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Login
              </button>
            </div>
          )}

          {view === VIEWS.LOGIN && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-muted">Enter your 4-move sequence to log in.</p>
              <SequenceInputPlaceholder onSequenceComplete={handleLogin} disabled={submitting} submitLabel="Login" />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button onClick={backToMenu} className="text-xs text-fg-muted hover:text-fg underline text-center">
                Back
              </button>
            </div>
          )}

          {view === VIEWS.CREATE && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-muted">Choose a permanent 4-move sequence for your new account.</p>
              <SequenceInputPlaceholder
                onSequenceComplete={handleCreateAccount}
                disabled={submitting || rateLimited}
                submitLabel="Create Account"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              {rateLimited && <p className="text-xs text-red-400">Too many attempts -- try again later.</p>}
              <button onClick={backToMenu} className="text-xs text-fg-muted hover:text-fg underline text-center">
                Back
              </button>
            </div>
          )}

          {view === VIEWS.MIGRATION_PROMPT && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg">Account created.</p>
              <p className="text-xs text-fg-muted">
                You have puzzle history on this device. Bring it into your new account, or start fresh?
              </p>
              {migrationError && <p className="text-xs text-red-400">{migrationError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={handleMerge}
                  disabled={migrating}
                  className="flex-1 rounded-lg border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-accent transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {migrating ? 'Working…' : 'Merge'}
                </button>
                <button
                  onClick={handleDiscard}
                  disabled={migrating}
                  className="flex-1 rounded-lg border border-border px-3 py-2 text-sm text-fg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {migrating ? 'Working…' : 'Discard'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
