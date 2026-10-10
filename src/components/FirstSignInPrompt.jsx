import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { GUEST_IDENTITY, getAllAttempts, getPreferences, markAttemptsSynced, resetAllLocalData } from '../utils/storage'

// Guest-to-account migration (Sub-build B2b, spec §5's "Guest -> account
// migration" -- one-time historical transfer at account creation only, NOT
// ongoing sync; a logged-in account's later attempts are pushed by
// storage.js's own recordAttempt/flushUnsyncedAttempts, wired to the login/
// foreground sequence in App.jsx). Runs after Create Account has already
// minted a real, authenticated session, so RLS (profile_id = auth.uid()) is
// what actually enforces every write below can only ever touch this new
// account's own rows -- these are plain supabase-js table calls, no Edge
// Function, confirmed viable against the live RLS policies during the B2b
// investigation pass.
//
// Write order: puzzle_attempts -> recompute_stats() -> preferences.
// profile_stats/theme_stats are no longer written directly here (Commit 6,
// ongoing sync) -- recompute_stats() (Commit 3) is the only path allowed to
// write them going forward, and it's called unconditionally, on both the
// fresh-migration branch below AND the already-migrated-retry branch,
// since a retry that skips re-inserting attempts must still ensure stats
// get computed at least once.
//
// Each row's id is that local attempt's own `remoteId` (generated once, at
// record-time, in recordAttempt -- see storage.js), not a fresh uuid
// minted here. This is what makes puzzle_attempts retry-safe: re-running
// this function with the same local data reuses the same ids, so a retried
// insert against rows that already landed hits 23505 (unique violation),
// not a duplicate row. A pre-Commit-1 local record predating the
// remoteId field falls back to a freshly generated one here, which is
// then persisted back onto the local record via markAttemptsSynced (not
// just marking it synced) -- otherwise that local record's remoteId would
// permanently disagree with the row actually created remotely, and a
// later pullRemoteAttempts() dedupe check (which matches on remoteId)
// would fail to recognize it as already-covered.
//
// The pre-check below (also serving as the locked decision's "confirm the
// empty-remote assumption at runtime" requirement) still decides whether
// to attempt the insert at all: if puzzle_attempts already has rows for
// this profile, either this is a resumed retry (skip re-inserting, move
// on -- any leftover locally-unsynced records among them self-heal via the
// login/foreground flush's own 23505-as-success handling, not duplicated
// here) or a genuinely unexpected pre-existing-data edge case (same safe
// response either way -- never append/duplicate).
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
    // Explicit GUEST_IDENTITY override, not auto-resolution -- by the time
    // this runs, the active session is already the new account (handleMerge
    // only fires after setSession() succeeded), so an unscoped call here
    // would read the new account's own empty namespace, not the guest data
    // being migrated (storage-partitioning-investigation.md, addendum 1).
    const localAttempts = await getAllAttempts({ identity: GUEST_IDENTITY })
    if (localAttempts.length > 0) {
      const attemptsWithRemoteId = localAttempts.map((a) => ({
        ...a,
        remoteId: a.remoteId ?? crypto.randomUUID(),
      }))
      const rows = attemptsWithRemoteId.map((a) => ({
        id: a.remoteId,
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

      // { identity: userId } here is a REASSIGNMENT, not a namespace-read
      // override -- storage.js's markAttemptsSynced looks these rows up by
      // raw store id (already identity-agnostic) regardless; this is what
      // actually transfers ownership of the row from GUEST_IDENTITY to the
      // new account, which is exactly what Merge means (see storage.js's own
      // doc comment on markAttemptsSynced for why this differs in kind from
      // the getAllAttempts/getPreferences overrides above/below).
      await markAttemptsSynced(
        attemptsWithRemoteId.map((a) => ({ id: a.id, remoteId: a.remoteId })),
        { identity: userId },
      )
    }
  }

  const { error: recomputeError } = await supabase.rpc('recompute_stats')
  if (recomputeError) throw new Error('recompute_stats failed')

  const prefs = await getPreferences({ identity: GUEST_IDENTITY })
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
 * Whether this sign-in is a new account's first sign-in on a device that
 * holds guest history -- the only case Merge/Discard is offered (Auth V2
 * spec D11, decision Q3). All three must hold:
 *   - this device has guest attempts to offer;
 *   - the account has no remote puzzle_attempts (a new account; never
 *     merge into one with history -- the same guard
 *     migrateGuestDataToAccount applies to its own insert);
 *   - the user hasn't already answered Merge/Discard on some device
 *     (user_metadata.guest_merge_resolved).
 * Called on every sign-in path (confirm link at boot, interactive sign-in),
 * because under Auth V2 the account's first session can appear in a
 * browser that has no guest data at all (a phone's in-app mail browser),
 * and the offer must still come up later on the device that does. If the
 * remote count can't be read, no offer: never risk merging into an account
 * that might already have history. Nothing is written here.
 */
export async function shouldOfferGuestMerge(session) {
  if (session?.user?.user_metadata?.guest_merge_resolved === true) return false
  const guestAttempts = await getAllAttempts({ identity: GUEST_IDENTITY })
  if (guestAttempts.length === 0) return false
  const { count, error } = await supabase
    .from('puzzle_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', session.user.id)
  if (error || typeof count !== 'number') return false
  return count === 0
}

// Records the user's Merge/Discard answer so no device offers it again.
// Only ever called from those two choices (decision Q3). Best-effort: if it
// fails, the answer itself already took effect -- after Merge the account
// has remote attempts, after Discard this device has no guest attempts --
// so shouldOfferGuestMerge won't re-offer here either way.
async function markGuestMergeResolved() {
  try {
    await supabase.auth.updateUser({ data: { guest_merge_resolved: true } })
  } catch {
    // see above
  }
}

/**
 * Merge/Discard prompt for a new account's first sign-in on a device with
 * guest history (moved out of LaunchOverlay for Auth V2: the session can
 * now first appear at boot, from a confirm link, when LaunchOverlay isn't
 * mounted). Rendered by App.jsx before the account becomes the active
 * session state, so the #1d sync/readiness sequence starts only after the
 * answer.
 *
 * @param {object} props
 * @param {object} props.session - the new account's live session.
 * @param {() => void} props.onResolved - Merge or Discard finished.
 */
export default function FirstSignInPrompt({ session, onResolved }) {
  // Disables both Merge/Discard buttons during their async operation
  // (locked decision: prevent double-submit) and drives the "Working…"
  // label.
  const [migrating, setMigrating] = useState(false)
  const [migrationError, setMigrationError] = useState('')

  async function handleMerge() {
    setMigrationError('')
    setMigrating(true)
    try {
      await migrateGuestDataToAccount(session.user.id)
    } catch {
      setMigrating(false)
      setMigrationError('Something went wrong bringing over your history -- try again.')
      return
    }
    await markGuestMergeResolved()
    setMigrating(false)
    onResolved()
  }

  async function handleDiscard() {
    setMigrationError('')
    setMigrating(true)
    // Explicit GUEST_IDENTITY override -- same reasoning as
    // migrateGuestDataToAccount above: the active session by this point is
    // already the new account, and Discard means "drop the guest history,"
    // not "wipe whatever identity happens to be active right now."
    await resetAllLocalData({ identity: GUEST_IDENTITY })
    await markGuestMergeResolved()
    setMigrating(false)
    onResolved()
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

          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg">Welcome to your new account.</p>
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
        </div>
      </div>
    </>
  )
}
