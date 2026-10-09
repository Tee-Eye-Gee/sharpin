import { DEFAULT_RATING } from './rating'
import { supabase } from '../lib/supabaseClient'

// Same flag/convention as App.jsx's ACCOUNT_SYNC_ENABLED -- checked here too
// so recordAttempt's push attempt (below) makes zero Supabase network calls
// when the feature is disabled, matching the existing "flag off means zero
// Supabase traffic" principle already established at boot in App.jsx.
const ACCOUNT_SYNC_ENABLED = import.meta.env.VITE_ENABLE_ACCOUNT_SYNC === 'true'

const DB_NAME = 'sharpin'
const DB_VERSION = 3
const STORE_PROFILE = 'profile'
const STORE_ATTEMPTS = 'attempts'
const STORE_THEME_STATS = 'themeStats'
const STORE_PREFERENCES = 'preferences'

// Storage partitioning (docs/specs/storage-partitioning-investigation.md,
// Option A): every local store is namespaced by identity -- a real account's
// id when logged in, this fixed sentinel otherwise. Exported so callers that
// need EXPLICIT access to the guest bucket regardless of whichever identity
// is currently active (LaunchOverlay.jsx's migrateGuestDataToAccount/
// handleDiscard -- see the `identity` override param on the functions below)
// can reference the same constant rather than duplicating the string.
export const GUEST_IDENTITY = 'guest'

// Resolves "who owns the data this call is about to read/write." Mirrors the
// exact pattern already used by pushAttemptIfPossible/pullRemoteAttempts
// (a live supabase.auth.getSession() call) rather than introducing a second
// identity source -- so every storage function's notion of "current
// identity" agrees with the same live session state those two already read.
// The ACCOUNT_SYNC_ENABLED short-circuit comes FIRST, not after an
// unconditional getSession() call, so the "flag off means zero Supabase
// traffic" invariant holds literally, not just "no traffic ends up
// happening" -- getSession() itself is a local-storage read with no network
// call when there's no session, but skipping it entirely when the feature
// is off keeps this file's existing guarantee exact.
//
// Deliberately NOT the right tool for every call site: LaunchOverlay.jsx's
// guest-to-account migration path (Merge/Discard) needs to operate on the
// GUEST_IDENTITY bucket specifically, regardless of the real account session
// that's already active by the time that code runs -- see the `identity`
// override parameter on getAllAttempts/getPreferences/resetAllLocalData/
// markAttemptsSynced below, which exists exactly for that case and must be
// used there instead of relying on this auto-resolution.
async function resolveIdentity() {
  if (!ACCOUNT_SYNC_ENABLED) return GUEST_IDENTITY
  const { data: { session } } = await supabase.auth.getSession()
  return session ? session.user.id : GUEST_IDENTITY
}

/**
 * Public read of "whose data would an unscoped storage call touch right
 * now" -- the same live resolution every auto-resolving function in this
 * file uses. usePuzzleEngine compares this against the identity a puzzle
 * was loaded for, so a commit can refuse to write when the two differ
 * (Backlog #1d, user-change expansion) instead of computing a rating delta
 * from some other identity's profile.
 */
export async function getActiveIdentity() {
  return resolveIdentity()
}

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE)
      }
      if (!db.objectStoreNames.contains(STORE_ATTEMPTS)) {
        db.createObjectStore(STORE_ATTEMPTS, { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains(STORE_THEME_STATS)) {
        db.createObjectStore(STORE_THEME_STATS)
      }
      if (!db.objectStoreNames.contains(STORE_PREFERENCES)) {
        db.createObjectStore(STORE_PREFERENCES)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode)
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const DEFAULT_PROFILE = {
  rating: DEFAULT_RATING,
  totalSolved: 0,
  totalFailed: 0,
  currentStreak: 0,
  bestStreak: 0,
}

// STORE_PROFILE/STORE_PREFERENCES are out-of-line stores keyed by an
// arbitrary string -- namespacing them is a pure key-scheme change (identity
// itself, no prefix needed: the store name already disambiguates "profile"
// from "preferences", so profile/guest and preferences/guest can't collide).
// Split into a private identity-taking half (reused by recordAttempt, which
// resolves identity once and threads it through several calls rather than
// re-resolving per call) and a public auto-resolving wrapper.
async function getProfileFor(identity) {
  const db = await openDB()
  const t = tx(db, [STORE_PROFILE], 'readonly')
  const result = await reqToPromise(t.objectStore(STORE_PROFILE).get(identity))
  return result ?? { ...DEFAULT_PROFILE }
}

/**
 * Load the user's profile (rating, streaks, solve counts), creating a
 * default one if this is a first run.
 *
 * `identity` override: read a specific identity's record regardless of the
 * live session -- usePuzzleEngine pins every read/write for one puzzle to
 * the identity that puzzle was loaded for (Backlog #1d).
 */
export async function getProfile({ identity } = {}) {
  return getProfileFor(identity ?? await resolveIdentity())
}

/**
 * Whether this device holds a stored profile record for `identity` at all.
 * Lets App.jsx tell "DEFAULT_PROFILE because this identity has never
 * played here" apart from "this device already has this identity's
 * history" when a post-login stats pull couldn't complete (Backlog #1d).
 */
export async function hasLocalProfile(identity) {
  const db = await openDB()
  const t = tx(db, [STORE_PROFILE], 'readonly')
  const result = await reqToPromise(t.objectStore(STORE_PROFILE).get(identity))
  return result !== undefined
}

async function saveProfile(profile, identity) {
  const db = await openDB()
  const t = tx(db, [STORE_PROFILE], 'readwrite')
  t.objectStore(STORE_PROFILE).put(profile, identity)
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

const DEFAULT_PREFERENCES = {
  appMode: null, // null until first OS-detection; then persisted and never re-detected
  boardTheme: 'tournament',
  inputMode: 'drag', // preserves current behavior for existing users until they opt into tap
  lastPulledAt: null, // ISO string watermark for pullRemoteAttempts; null means "never pulled"
  // Ongoing preference sync (docs/specs/theme-preferences-sync-investigation.md):
  // `synced`/`preferencesUpdatedAt` are this record's own equivalents of
  // attempts' `synced`/watermark, added here rather than as new top-level
  // fields elsewhere since preferences is a single row, not a log. Records
  // written before this existed have neither field -- default synced to
  // true (never retroactively "pending"), same reasoning and same
  // spread-default mechanism as withSyncedDefault's attempts-side default.
  synced: true,
  preferencesUpdatedAt: null, // this device's last-confirmed server updated_at for this row; distinct from lastPulledAt (attempts' own watermark) -- never conflate the two.
  // Out-of-order-response guard: identifies WHICH local write a push's
  // eventual success response corresponds to. Two independent code paths
  // can each have a push in flight for the same pending edit at once --
  // updatePreferences' own click-triggered push, and syncPreferences'
  // push-branch retrying that same still-unsynced edit on a foreground/
  // login trigger -- and either one's response can arrive after a NEWER
  // edit has already superseded it. `pendingToken` is what
  // pushPreferencesIfPossible checks, from EITHER path, before flipping
  // `synced: true`, so a stale response (regardless of which path produced
  // it) can never mark a fresher, still-actually-unpushed edit as synced.
  // null means "nothing pending."
  pendingToken: null,
}

async function getPreferencesFor(identity) {
  const db = await openDB()
  const t = tx(db, [STORE_PREFERENCES], 'readonly')
  const result = await reqToPromise(t.objectStore(STORE_PREFERENCES).get(identity))
  return { ...DEFAULT_PREFERENCES, ...result }
}

/**
 * Load the user's app-mode/board-theme/input-mode preferences, creating the
 * defaults if this is a first run. Merges over DEFAULT_PREFERENCES rather
 * than returning a stored record as-is, so a key added after a user's first
 * visit (e.g. inputMode) still resolves to its default on their existing,
 * older-shaped record instead of coming back undefined.
 *
 * `identity` override: pass `{ identity: GUEST_IDENTITY }` to read the guest
 * bucket explicitly regardless of the currently-active session -- needed by
 * LaunchOverlay.jsx's migrateGuestDataToAccount, which runs after a new
 * account's session is already active but must read the GUEST data being
 * migrated, not the (still-empty) new account's own preferences.
 */
export async function getPreferences({ identity } = {}) {
  return getPreferencesFor(identity ?? await resolveIdentity())
}

async function savePreferencesFor(preferences, identity) {
  const db = await openDB()
  const t = tx(db, [STORE_PREFERENCES], 'readwrite')
  t.objectStore(STORE_PREFERENCES).put(preferences, identity)
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

// Deliberately NOT the entry point for user/system-facing preference
// changes (see updatePreferences below) -- this stays a plain, no-push
// local write, and is exactly the right tool for pullRemoteAttempts' own
// lastPulledAt-only bookkeeping (storage.js's pullRemoteAttempts), which
// must never trigger a preferences push: lastPulledAt has no server
// column, and pushing on every attempts pull would be both wasteful and
// conceptually wrong (theme-preferences-sync-investigation.md §2).
export async function savePreferences(preferences) {
  const identity = await resolveIdentity()
  return savePreferencesFor(preferences, identity)
}

/**
 * Attempts a real-time push of the given preferences state to the
 * `preferences` table. Unlike puzzle_attempts, this is a single-row upsert
 * keyed by `profile_id` (that table's own primary key) -- naturally
 * idempotent with no remoteId/dedup scheme needed at all; retrying the same
 * upsert just re-writes the same one row (theme-preferences-sync-
 * investigation.md §2). No-ops (zero network calls) if the account-sync
 * feature is disabled or there's no active session -- same "flag off means
 * zero Supabase traffic" principle as pushAttemptIfPossible.
 *
 * `synced` transitions to `true` ONLY here, ONLY after a confirmed success
 * response -- never speculatively, never on request-send. Any error leaves
 * `synced: false` for the next sync trigger to retry, identical in spirit
 * to pushAttemptIfPossible's own contract.
 *
 * `pendingToken` is the out-of-order-response guard, REQUIRED and checked
 * regardless of which caller supplied it: this function is reachable from
 * TWO independent code paths -- updatePreferences' own click-triggered
 * push, and syncPreferences' push-branch retrying an already-pending edit
 * on a foreground/login trigger -- and either one's response can arrive
 * after a newer edit has already superseded the one it was for. Before
 * writing the confirmation back, this re-reads the record fresh
 * (`getPreferencesFor`, never the `prefs` snapshot captured when this push
 * started) and only marks `synced: true` if that fresh record's own
 * `pendingToken` still matches the token THIS push was for. If a newer
 * local edit has since generated a different token, this response is
 * stale -- discarded outright, `synced` stays exactly as the newer,
 * still-genuinely-unsynced edit left it, regardless of which of the two
 * call paths this particular (now-stale) response came from.
 *
 * Identity-pinned guard (docs/specs/identity-pinned-push-guard-investigation.md,
 * Backlog #1e): `identity` is the caller's already-resolved pin (from
 * updatePreferences' click-triggered call, or syncPreferences' own
 * already-resolved value on its retry-branch call) -- not re-derived here.
 * The `getSession()` call above, by contrast, is necessarily fresh --
 * same reasoning as pushAttemptIfPossible's own identical guard. If the
 * two disagree, the live session has moved to a different identity since
 * this write was queued (only reachable once Logout exists). This case is
 * more urgent to catch here than on the attempts side: `preferences` is a
 * single-row upsert with no dedup/append safety net, so proceeding
 * wouldn't just misattribute a row -- it would directly overwrite whatever
 * that other account's real settings already were, the instant they log
 * in. Aborting before the upsert leaves this identity's own record exactly
 * as if the push hadn't run (`synced: false`, `pendingToken` untouched),
 * correctly retried the next time this identity's own session is live.
 */
async function pushPreferencesIfPossible(prefs, identity, pendingToken) {
  if (!ACCOUNT_SYNC_ENABLED) return

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return
  if (session.user.id !== identity) return // identity moved on since this write was queued -- leave synced:false for a correctly-scoped retry

  const { data, error } = await supabase
    .from('preferences')
    .upsert(
      { profile_id: session.user.id, app_mode: prefs.appMode, board_theme: prefs.boardTheme, input_mode: prefs.inputMode },
      { onConflict: 'profile_id' },
    )
    .select('updated_at')
    .single()

  if (error) return // leave synced:false: the next sync trigger retries

  const latest = await getPreferencesFor(identity)
  if (latest.pendingToken !== pendingToken) return // superseded by a newer local edit -- discard, do not touch synced

  await savePreferencesFor({ ...latest, synced: true, preferencesUpdatedAt: data.updated_at, pendingToken: null }, identity)
}

/**
 * The entry point for every user/system-facing preference change
 * (appMode/boardTheme/inputMode) -- App.jsx's toggleAppMode/
 * selectBoardTheme/selectInputMode, and its boot effect's one-time
 * OS-mode-detection write, all call this rather than getPreferences()/
 * savePreferences() directly. NOT used by pullRemoteAttempts' own
 * lastPulledAt bookkeeping -- see savePreferences' own comment for why.
 *
 * Mirrors recordAttempt's shape: the local write is fully awaited and
 * committed to IndexedDB BEFORE the fire-and-forget push is dispatched --
 * this ordering is load-bearing, not stylistic (theme-preferences-sync-
 * investigation.md's addendum traces exactly why: it's what guarantees a
 * concurrent read can never observe a stale `synced: true` while a real
 * local change is actually pending). No cached/reused preferences object
 * is threaded across calls anywhere here -- every read goes directly to
 * IndexedDB, preserving that same guarantee.
 *
 * Generates a fresh `pendingToken` for THIS write specifically -- this is
 * what lets pushPreferencesIfPossible tell, later, whether its eventual
 * response is still for the write that's currently pending or for one a
 * newer edit has since superseded.
 */
export async function updatePreferences(partial) {
  const identity = await resolveIdentity()
  const current = await getPreferencesFor(identity)
  const pendingToken = crypto.randomUUID()
  const prefs = { ...current, ...partial, synced: false, pendingToken }
  await savePreferencesFor(prefs, identity)
  pushPreferencesIfPossible(prefs, identity, pendingToken).catch(() => {})
  return prefs
}

/**
 * Preferences' own sync step, meant to be folded into the same login/
 * foreground-triggered sequence attempts already uses (App.jsx's
 * runSyncSequence), riding that same syncInFlightRef mutex -- but
 * deliberately NOT attempts' own pull-then-push order. Full trace:
 * docs/specs/theme-preferences-sync-investigation.md §3. Preferences is a
 * single mutable row, not an append-only log, so pull-then-push (safe for
 * attempts, since pulled rows can never overwrite a locally-pending
 * unsynced row -- they're independent rows) would risk pull silently
 * clobbering a genuinely-pending local edit here, where pull and a pending
 * edit target the exact same record. The two steps are mutually exclusive
 * branches instead, never both in the same pass:
 *
 * - Local record unsynced (a real pending edit): retry its push (the
 *   original fire-and-forget attempt from updatePreferences may have
 *   failed, or still be in flight -- a retry is safe and idempotent
 *   either way, since preferences upsert has no dedup concerns at all).
 *   Do NOT pull this trigger -- pulling now, while a local edit is
 *   genuinely pending, is exactly the clobber risk this branch design
 *   exists to avoid.
 * - Local record already synced (nothing pending to protect): pull is
 *   the only step that runs. Compares the server row's `updated_at`
 *   against this device's own `preferencesUpdatedAt` specifically --
 *   NEVER `lastPulledAt`, which is attempts' own, unrelated watermark; the
 *   two fields are deliberately kept distinct in this record for exactly
 *   this reason. No incoming row at all (an account that was created with
 *   no guest history to migrate, and has never pushed a preference change
 *   since) is a safe no-op, not an error.
 *
 * This already-locked LWW policy (Sharpin_Spec_AccountSync.md: "the more
 * recent device-side change wins") holds correctly in both directions this
 * way -- a genuinely more-recent local edit reaches the server before
 * anything can overwrite it; a genuinely more-recent server-side change
 * (from another device) is picked up whenever this device has nothing of
 * its own pending.
 *
 * Identity-checked pull branch (docs/specs/pull-side-identity-race-
 * investigation.md, Backlog #1f): `identity` (resolved once, above) is the
 * write target for the pulled data below; the pull branch's own
 * `getSession()` call, several lines later, is a SEPARATE, necessary
 * resolution -- unlike pullRemoteAttempts' internal calls, it isn't purely
 * redundant: it's what authenticates the outbound `preferences` query and
 * correctly short-circuits the guest case (`identity` alone can be
 * GUEST_IDENTITY here, since only `local.synced` gates this branch, and a
 * literal `'guest'` string is nonsense as a `profile_id` filter). If the
 * two disagree, the live session has moved to a different identity since
 * `identity` was resolved -- proceeding would write a DIFFERENT account's
 * real preferences into THIS identity's local record, corrupting it
 * outright (a single mutable row has no dedup/append safety net the way
 * attempts does, so there's no safe partial action on a mismatch, only
 * "don't write"). On a detected mismatch this does not silently give up
 * forever: it re-resolves and retries once, fresh, within this same
 * trigger (a plain recursive call re-derives `identity`/`local` from
 * scratch for whichever identity is now actually live, rather than
 * patching the in-flight operation with a stale/live data mix) -- bounded
 * to one retry, so if identity is STILL changing that fast, this defers
 * cleanly to the next trigger (a fresh login or foreground event, both of
 * which already re-invoke this function via App.jsx's runSyncSequence)
 * rather than looping.
 */
export async function syncPreferences(retriesLeft = 1) {
  if (!ACCOUNT_SYNC_ENABLED) return

  const identity = await resolveIdentity()
  const local = await getPreferencesFor(identity)

  if (!local.synced) {
    // Retrying the SAME still-pending edit, not creating a new one -- pass
    // its existing pendingToken through unchanged, not a freshly generated
    // one. This is exactly what lets pushPreferencesIfPossible's guard
    // treat this retry's eventual response identically to the original
    // click-triggered push's own response: both carry the same token, so
    // whichever happens to resolve first correctly confirms the edit, and
    // the other's (now-redundant, not stale) response is a harmless no-op.
    await pushPreferencesIfPossible(local, identity, local.pendingToken)
    return
  }

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return
  if (session.user.id !== identity) {
    if (retriesLeft > 0) return syncPreferences(retriesLeft - 1)
    return // identity churned across both attempts -- defer to the next trigger rather than loop
  }

  const { data, error } = await supabase
    .from('preferences')
    .select('app_mode, board_theme, input_mode, updated_at')
    .eq('profile_id', session.user.id)
    .maybeSingle()

  if (error || !data) return
  if (local.preferencesUpdatedAt !== null && data.updated_at <= local.preferencesUpdatedAt) return

  await savePreferencesFor(
    {
      ...local,
      appMode: data.app_mode,
      boardTheme: data.board_theme,
      inputMode: data.input_mode,
      preferencesUpdatedAt: data.updated_at,
    },
    identity,
  )
}

/**
 * Per-theme accuracy: { [theme]: { attempts, solved } }
 *
 * STORE_THEME_STATS is keyed by bare theme name today; namespacing it means
 * a compound `${identity}::${theme}` key rather than a schema change (still
 * an out-of-line store, still an arbitrary string key -- no DB_VERSION bump,
 * per the investigated design). Filters by prefix and strips it back off
 * when rebuilding the returned map, so callers see the exact same shape as
 * before.
 */
export async function getThemeStats() {
  const identity = await resolveIdentity()
  const db = await openDB()
  const t = tx(db, [STORE_THEME_STATS], 'readonly')
  const store = t.objectStore(STORE_THEME_STATS)
  const keys = await reqToPromise(store.getAllKeys())
  const values = await reqToPromise(store.getAll())
  const prefix = `${identity}::`
  const stats = {}
  keys.forEach((key, i) => {
    if (typeof key === 'string' && key.startsWith(prefix)) {
      stats[key.slice(prefix.length)] = values[i]
    }
  })
  return stats
}

async function bumpThemeStats(db, identity, themes, solved) {
  const t = tx(db, [STORE_THEME_STATS], 'readwrite')
  const store = t.objectStore(STORE_THEME_STATS)
  const prefix = `${identity}::`
  for (const theme of themes) {
    const key = prefix + theme
    const existing = await reqToPromise(store.get(key))
    const current = existing ?? { attempts: 0, solved: 0 }
    current.attempts += 1
    if (solved) current.solved += 1
    store.put(current, key)
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

/**
 * The user's weakest themes (lowest solve accuracy with enough of a sample
 * to be meaningful), worst-first. Feeds both the progress panel and the
 * coach prompt's running weak-pattern context.
 */
export async function getWeakThemes(limit = 3, minAttempts = 3) {
  const stats = await getThemeStats()
  return Object.entries(stats)
    .filter(([, s]) => s.attempts >= minAttempts)
    .map(([theme, s]) => ({ theme, accuracy: s.solved / s.attempts, attempts: s.attempts }))
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, limit)
}

// v3 added hintUsed to the attempt record shape; records written under v2
// have no such field. Default it at read time (same pattern as
// getPreferences' spread-default) rather than backfilling stored rows.
function withHintUsedDefault(attempt) {
  return { ...attempt, hintUsed: attempt.hintUsed ?? false }
}

// Ongoing sync (backlog #1 continuation) added `synced` to track whether a
// locally-recorded attempt has landed in puzzle_attempts yet. Records
// written before this existed have no such field -- default them to true,
// not false: they predate the push mechanism entirely, so they should never
// retroactively queue for push (locked decision). Same at-read-time
// defaulting pattern as withHintUsedDefault above.
function withSyncedDefault(attempt) {
  return { ...attempt, synced: attempt.synced ?? true }
}

// STORE_ATTEMPTS stays a single, unpartitioned-by-schema store (still
// keyPath: 'id', autoIncrement -- no DB_VERSION bump) -- namespacing it
// means an `ownerId` field on each record rather than separate stores, and
// every read filters by `ownerId === <the identity in question>` after
// getAll() (row counts here are one person's puzzle history, not a scale
// where this needs an index).
//
// Deliberate, load-bearing detail: the filter is strict equality against a
// concrete identity, with NO special case for a record whose `ownerId` is
// altogether absent. A record with no `ownerId` at all is legacy data
// written before this partitioning existed -- it must stay invisible to
// every identity's ordinary reads until Commit 3's first-boot adoption
// routine explicitly tags it, not silently attach itself to whichever
// identity happens to read first. This is expected, already-investigated
// behavior, not a gap: on a device with real pre-Commit-1 legacy data,
// between this commit landing and Commit 3's adoption routine shipping,
// that data is intentionally invisible (reads return empty/defaults) rather
// than guessed-at.

/**
 * Most recent N attempts, newest first — used to weight puzzle selection
 * away from themes the user has just seen.
 */
export async function getRecentAttempts(limit = 15, { identity: explicitIdentity } = {}) {
  const identity = explicitIdentity ?? await resolveIdentity()
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  const all = await reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
  const owned = all.filter((a) => a.ownerId === identity)
  return owned.slice(-limit).reverse().map((a) => withSyncedDefault(withHintUsedDefault(a)))
}

/**
 * The full attempt history, newest first — used by the rule-based coach to
 * find each theme's most recent occurrences regardless of how far back they
 * fall (a rare theme's last 10 attempts may be older than any fixed window).
 *
 * `identity` override: see getPreferences' doc comment above -- same
 * reasoning, same caller (migrateGuestDataToAccount needs the GUEST bucket
 * explicitly, not whatever identity is currently active).
 */
export async function getAllAttempts({ identity } = {}) {
  const activeIdentity = identity ?? await resolveIdentity()
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  const all = await reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
  const owned = all.filter((a) => a.ownerId === activeIdentity)
  return owned.slice().reverse().map((a) => withSyncedDefault(withHintUsedDefault(a)))
}

/**
 * Every locally-stored attempt not yet confirmed pushed to puzzle_attempts --
 * the retry queue flushUnsyncedAttempts() below drains. Each record's own
 * `id` (the local autoincrement key) is what markAttemptSynced needs to
 * update the right row back; `remoteId` is the row's separate, stable
 * identity in Supabase (see recordAttempt's own comment for why these are
 * two different values). Scoped to the current identity's own rows --
 * structurally can never surface a different identity's unsynced rows, so
 * flushUnsyncedAttempts can never push someone else's history under the
 * wrong profile_id.
 */
export async function getUnsyncedAttempts() {
  const identity = await resolveIdentity()
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  const all = await reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
  return all
    .filter((a) => a.ownerId === identity)
    .map((a) => withSyncedDefault(withHintUsedDefault(a)))
    .filter((a) => !a.synced)
}

// Returns the store's own generated key (available on the add request
// itself once it succeeds, ahead of the transaction's overall completion --
// standard IndexedDB request/transaction ordering) so recordAttempt can
// pass it straight to markAttemptSynced later without a second read.
async function appendAttempt(db, attempt) {
  const t = tx(db, [STORE_ATTEMPTS], 'readwrite')
  const addReq = t.objectStore(STORE_ATTEMPTS).add(attempt)
  return new Promise((resolve, reject) => {
    let localId
    addReq.onsuccess = () => { localId = addReq.result }
    t.oncomplete = () => resolve(localId)
    t.onerror = () => reject(t.error)
  })
}

/**
 * Marks locally-stored attempts as pushed to puzzle_attempts, in one
 * transaction. Keyed by each entry's `id` (the local store id --
 * appendAttempt's own return value / each getUnsyncedAttempts record's
 * `.id`), not `remoteId`. `remoteId` is optional per entry and, when given,
 * is written back onto the local record too -- needed by
 * migrateGuestDataToAccount (LaunchOverlay.jsx), which may have to generate
 * a fresh remoteId for a pre-Commit-1 local record that predates that
 * field; without persisting it back, that record's local remoteId would
 * stay out of sync with the row actually created remotely, and a later
 * pullRemoteAttempts() dedupe check (which matches on remoteId) would fail
 * to recognize that remote row as already-covered and insert a duplicate.
 *
 * `identity` override, distinct in kind from getAllAttempts/getPreferences'
 * above: lookup here is always by raw store id (already identity-agnostic --
 * autoincrement keys are unique store-wide), so there's nothing to "read
 * under the wrong namespace." What this parameter controls instead is
 * whether the row's `ownerId` gets REASSIGNED. Ordinary push-success
 * (pushAttemptIfPossible, no identity passed) must leave `ownerId` exactly
 * as it already was -- the row already belongs to whoever's pushing it.
 * migrateGuestDataToAccount passes the new account's id here specifically
 * because Merge IS the moment a guest-owned row's ownership actually
 * transfers -- this is the one legitimate place a row's `ownerId` changes
 * after creation.
 *
 * STORE_ATTEMPTS is an in-line-keyed store ({ keyPath: 'id', autoIncrement:
 * true }) -- unlike the other three stores (out-of-line, no keyPath), its
 * key lives INSIDE the stored object itself. put() on an in-line-keyed
 * store must be called with no second key argument (that's only valid for
 * out-of-line stores) -- the key is derived from the object's own `id`
 * field, which `existing` already carries from the read below.
 */
export async function markAttemptsSynced(entries, { identity } = {}) {
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readwrite')
  const store = t.objectStore(STORE_ATTEMPTS)
  for (const { id, remoteId } of entries) {
    const existing = await reqToPromise(store.get(id))
    if (!existing) continue
    store.put({
      ...existing,
      remoteId: remoteId ?? existing.remoteId,
      synced: true,
      ownerId: identity ?? existing.ownerId,
    })
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

async function markAttemptSynced(localId, remoteId) {
  return markAttemptsSynced([{ id: localId, remoteId }])
}

/**
 * Attempts a real-time push of one already-locally-written attempt to
 * puzzle_attempts (locked design: push happens after every attempt while
 * logged in, direct client write -- RLS already scopes this to the
 * caller's own profile_id, no Edge Function). No-ops (zero network calls)
 * if the account-sync feature is disabled or there's no active session --
 * same "flag off means zero Supabase traffic" principle as App.jsx's boot
 * check.
 *
 * `attempt.remoteId` is a uuid generated once, at local-write time, in
 * recordAttempt -- reused identically on every retry (this same function is
 * what flushUnsyncedAttempts calls per queued row). A 23505 (unique
 * violation on that id) therefore means this exact row already landed
 * server-side from an earlier attempt whose success response never made it
 * back to the client -- treated as success, not a failure.
 *
 * Identity-pinned guard (docs/specs/identity-pinned-push-guard-investigation.md,
 * Backlog #1e): `attempt.ownerId` was resolved once, back in recordAttempt,
 * at the moment this attempt was recorded -- it never changes after that.
 * This function's own `getSession()` call above, by contrast, is
 * necessarily re-resolved fresh at execution time (a fire-and-forget push
 * may run long after the write was queued, and needs a currently-valid
 * session to authenticate the call at all -- a value pinned at record time
 * couldn't stand in for that). If the two disagree, the live session has
 * moved on to a different identity since this attempt was recorded (only
 * reachable once Logout exists, per the investigation) -- proceeding would
 * insert this attempt's real data under the WRONG account's profile_id
 * (RLS does not catch this: profile_id is derived from the same session
 * authenticating the call, so the write is self-consistent from RLS's own
 * point of view regardless of whose data it actually is). Aborting here,
 * before the insert, leaves the row exactly as if this push simply hadn't
 * run yet (`synced: false`) -- safe and correct, since a future
 * `flushUnsyncedAttempts()` call, once this row's own identity is live
 * again, is filtered by `ownerId` and will retry it correctly then. This
 * also closes a narrower, already-latent version of the same race in the
 * guest-to-account direction: a guest's `ownerId` is the literal string
 * `'guest'`, which can never equal a real account's uuid, so a guest
 * attempt's stray push can no longer land under whichever account happens
 * to be logging in while it's in flight -- previously possible, and capable
 * of silently surviving a subsequent Discard (see the investigation for the
 * full trace).
 */
async function pushAttemptIfPossible(attempt) {
  if (!ACCOUNT_SYNC_ENABLED) return

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return
  if (session.user.id !== attempt.ownerId) return // identity moved on since this attempt was recorded -- leave synced:false for a correctly-scoped retry

  const { error } = await supabase.from('puzzle_attempts').insert({
    id: attempt.remoteId,
    profile_id: session.user.id,
    puzzle_id: attempt.puzzleId,
    themes: attempt.themes,
    solved: attempt.solved,
    hint_used: attempt.hintUsed,
    rating_delta: attempt.ratingDelta,
    time_taken_ms: attempt.timeTakenMs,
    attempted_at: new Date(attempt.at).toISOString(),
  })

  if (!error || error.code === '23505') {
    await markAttemptSynced(attempt.id, attempt.remoteId)
  }
  // Any other error: leave synced:false: flushUnsyncedAttempts retries it later.
}

/**
 * Retries pushing every locally-unsynced attempt -- the retry queue for
 * whatever recordAttempt's own real-time push didn't manage to land
 * (offline, a dropped connection mid-request, etc.). Safe to call with the
 * feature disabled or no session (each row's push attempt no-ops via
 * pushAttemptIfPossible's own guard); safe to call repeatedly (idempotent,
 * per the 23505-as-success handling above).
 */
export async function flushUnsyncedAttempts() {
  const unsynced = await getUnsyncedAttempts()
  for (const attempt of unsynced) {
    await pushAttemptIfPossible(attempt)
  }
}

/**
 * Pulls any remote puzzle_attempts rows not yet reflected locally since the
 * last successful pull, and bulk-inserts them into the local attempts store.
 *
 * Watermark column is `updated_at`, not `attempted_at`. attempted_at is
 * client-set at solve time; a delayed flushUnsyncedAttempts retry can
 * insert a row whose attempted_at is well before a watermark that has
 * already advanced past it, silently skipping that row forever. updated_at
 * is server-set via puzzle_attempts_set_updated_at (`before insert or
 * update`, stamps now()) -- confirmed by reading the schema directly, this
 * column already exists for exactly this purpose (its own migration comment
 * calls it "the server-set LWW conflict-resolution timestamp"), and no
 * client code path ever UPDATEs a puzzle_attempts row after insert, so it
 * behaves as a pure insertion timestamp in practice.
 *
 * Dedupes fetched rows against remoteIds already present locally before
 * inserting -- required, not just defensive: a row this same device already
 * pushed can still fall after the last pull's watermark and reappear in
 * this query. Without the dedupe it would be inserted a second time under a
 * new local autoincrement key. The dedupe set is built from this identity's
 * own getAllAttempts() -- consistent with everything else here, a pull can
 * only ever affect this identity's own rows.
 *
 * Every inserted row is written with synced: true and ownerId: the pulling
 * session's own user id immediately -- an unflagged pulled row risks being
 * swept into flushUnsyncedAttempts and causing a duplicate-key (23505)
 * conflict on re-push; an untagged one would be invisible to every
 * identity's reads (see the STORE_ATTEMPTS comment above) including the
 * very session that just pulled it.
 *
 * Identity-pinning (docs/specs/pull-side-identity-race-investigation.md,
 * Backlog #1f): `identity` is resolved once, immediately below, from this
 * function's own `session` -- and threaded explicitly through the dedup
 * read and the watermark write later in this function, rather than letting
 * either re-resolve it independently (which is what they did before this
 * fix, via getAllAttempts()/savePreferences()'s own auto-resolution). This
 * matters here specifically because both of those calls sit AFTER the
 * network round-trip immediately below -- a real macrotask-yielding gap a
 * same-page-load identity switch (once Logout exists) could land inside.
 * Unlike pushAttemptIfPossible's own guard (a genuine compare-and-abort,
 * because that function legitimately needs a session re-resolved at
 * execution time to authenticate its call), neither getAllAttempts nor the
 * watermark write here has any such need -- they're purely local IndexedDB
 * operations that only need to know which identity's records to touch, a
 * fact this function already has. Threading it through eliminates the
 * divergence rather than merely detecting it.
 */
export async function pullRemoteAttempts() {
  if (!ACCOUNT_SYNC_ENABLED) return { pulled: 0 }

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { pulled: 0 }

  // `identity` is NOT threaded into the very next call below, on purpose --
  // confirmed, not assumed, per docs/specs/pull-side-identity-race-
  // investigation.md §1: the gap between this line and the next has no
  // network or IndexedDB operation in it, so it's a pure microtask chain.
  // JS's run-to-completion guarantee means a real browser event (a Logout/
  // Login click) cannot be processed in between two back-to-back
  // microtask-only awaits with nothing macrotask-yielding between them --
  // this specific gap is not reachable by a same-page-load identity
  // switch. THIS IS A TIME-LIMITED GUARANTEE, NOT A PERMANENT ONE (same
  // caveat CLAUDE.md already states for adoptLegacyDataIfSafe's own
  // guest-vs-stranded heuristic): if a future edit inserts a real await
  // here (a network call, an IndexedDB read/write) between this line and
  // getPreferences() below, this unreachability claim must be re-verified,
  // not assumed to still hold -- at that point this call would need the
  // same explicit `{ identity }` threading the two calls below already
  // have.
  const prefs = await getPreferences()
  const identity = session.user.id
  const watermark = prefs.lastPulledAt ?? '1970-01-01T00:00:00.000Z'

  const { data, error } = await supabase
    .from('puzzle_attempts')
    .select('id, puzzle_id, themes, solved, hint_used, rating_delta, time_taken_ms, attempted_at, updated_at')
    .eq('profile_id', identity)
    .gt('updated_at', watermark)

  if (error) return { pulled: 0 }
  // Nothing to advance past -- leave last_pulled_at untouched rather than
  // re-stamping it to "now": with no rows to anchor to, that would risk
  // skipping ahead of a row committed server-side after this query ran but
  // before the watermark write, the same class of race this design exists
  // to avoid on the push side.
  if (data.length === 0) return { pulled: 0 }

  // Pinned to `identity` (above), not re-resolved -- see this function's
  // own doc comment for why.
  const existingRemoteIds = new Set((await getAllAttempts({ identity })).map((a) => a.remoteId))
  const newRows = data.filter((row) => !existingRemoteIds.has(row.id))

  if (newRows.length > 0) {
    const db = await openDB()
    const t = tx(db, [STORE_ATTEMPTS], 'readwrite')
    const store = t.objectStore(STORE_ATTEMPTS)
    for (const row of newRows) {
      store.add({
        puzzleId: row.puzzle_id,
        themes: row.themes,
        solved: row.solved,
        hintUsed: row.hint_used,
        ratingDelta: row.rating_delta,
        timeTakenMs: row.time_taken_ms,
        at: new Date(row.attempted_at).getTime(),
        synced: true,
        remoteId: row.id,
        ownerId: identity,
      })
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
  }

  // Advance to the max updated_at among rows the query actually returned --
  // not the client's current time. Anchoring to a value the server itself
  // already committed closes the race where a row lands between this
  // query running and the watermark being set: that row's updated_at is
  // necessarily > any value in `data`, so it stays > the new watermark and
  // will be picked up by the next pull, instead of being silently skipped
  // forever. Computed from `data` (every row the query matched), not
  // `newRows` (post-dedupe) -- a self-pull that returns rows this device
  // already has locally still legitimately confirms the server state up to
  // those rows' timestamps.
  const maxUpdatedAt = data.reduce((max, row) => (row.updated_at > max ? row.updated_at : max), data[0].updated_at)
  // savePreferencesFor (private, identity-pinned) -- NOT the public
  // savePreferences() wrapper, which would re-resolve identity
  // independently at exactly the point this fix exists to close. Same
  // module, no new public surface needed.
  await savePreferencesFor({ ...prefs, lastPulledAt: maxUpdatedAt }, identity)

  return { pulled: newRows.length }
}

/**
 * Pulls this identity's server-computed `profile_stats`/`theme_stats`
 * aggregate down into the local `profile`/`themeStats` stores, overwriting
 * whatever is there. Backlog #1g
 * (docs/specs/guest-merge-profile-migration-investigation.md):
 * `migrateGuestDataToAccount`/`recompute_stats()` correctly write these
 * tables server-side, but nothing ever pulled them back down locally --
 * reachable via both the guest-to-account Merge path and an ordinary Login
 * on any device without a local record for this identity (ordinary Login
 * only pulls `puzzle_attempts` via `pullRemoteAttempts`, never this).
 *
 * Deliberately NOT `syncPreferences`' push/pull-guard shape (`pendingToken`,
 * an `updated_at`-compare-before-write gate) -- confirmed, not assumed, per
 * the investigation: `profile_stats`/`theme_stats` have no locally-pending-
 * edit concept at all. Nothing in this codebase ever writes them via a user
 * action; they're a pure, wholesale-recomputed derived aggregate, rebuilt
 * from scratch by `recompute_stats()` every time it runs. A plain
 * unconditional overwrite is therefore always correct here, not merely
 * simpler -- there is no local edit a pull could ever clobber, so the
 * mutual-exclusion machinery `preferences` needs for exactly that reason
 * would be over-built for a data shape that doesn't have it.
 *
 * Identity is resolved once, at the top, and threaded through every
 * subsequent call (same discipline as #1e/#1f's identity-pinned guards) --
 * never re-resolved mid-function, even though two separate network round
 * trips happen after it's captured.
 *
 * Safe no-op (leaves local state exactly as it already was) if the feature
 * is disabled, there's no session, or no `profile_stats` row exists yet for
 * this identity (e.g. `recompute_stats()` has genuinely never run for this
 * account) -- matches `syncPreferences`' own "no incoming row is a safe
 * no-op" posture.
 *
 * Returns `null` when it did nothing at all (flag off, no session), else
 * `{ identity, ok }`: `ok: true` once this identity's local profile is known
 * to match the server (written, or the server genuinely has no row yet),
 * `ok: false` if either query errored. App.jsx uses this to decide when an
 * account's profile is ready for puzzle selection and rating math
 * (Backlog #1d).
 */
export async function pullProfileStats() {
  if (!ACCOUNT_SYNC_ENABLED) return null

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const identity = session.user.id

  const { data: statsRow, error: statsError } = await supabase
    .from('profile_stats')
    .select('rating, current_streak, best_streak, total_solved, total_failed')
    .eq('profile_id', identity)
    .maybeSingle()
  if (statsError) return { identity, ok: false }
  if (!statsRow) return { identity, ok: true }

  const { data: themeRows, error: themeError } = await supabase
    .from('theme_stats')
    .select('theme, attempts, solved')
    .eq('profile_id', identity)
  if (themeError) return { identity, ok: false }

  await saveProfile(
    {
      rating: statsRow.rating,
      totalSolved: statsRow.total_solved,
      totalFailed: statsRow.total_failed,
      currentStreak: statsRow.current_streak,
      bestStreak: statsRow.best_streak,
    },
    identity,
  )

  const db = await openDB()
  const t = tx(db, [STORE_THEME_STATS], 'readwrite')
  const store = t.objectStore(STORE_THEME_STATS)
  for (const row of themeRows ?? []) {
    store.put({ attempts: row.attempts, solved: row.solved }, `${identity}::${row.theme}`)
  }
  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
  return { identity, ok: true }
}

/**
 * Record a completed puzzle attempt: updates the attempt log, per-theme
 * accuracy, and the rolling profile (rating/streak/counts) in one place.
 *
 * Identity is resolved exactly once, up front, and threaded through every
 * sub-write (profile, attempts, theme stats) rather than each sub-call
 * re-resolving it independently -- guarantees one consistent identity
 * snapshot for the whole operation instead of relying on the session
 * staying put across several separate getSession() calls.
 *
 * @param {object} params
 * @param {string} params.puzzleId
 * @param {string[]} params.themes
 * @param {boolean} params.solved
 * @param {boolean} params.hintUsed
 * @param {number} params.newRating
 * @param {number} params.ratingDelta
 * @param {number} params.timeTakenMs
 * @param {string} [params.identity] - write under this identity instead of
 *   resolving the live session. usePuzzleEngine passes the identity the
 *   puzzle was loaded for, so its profile read and this write can't
 *   straddle a user change (Backlog #1d).
 * @returns {Promise<object>} the updated profile
 */
export async function recordAttempt({ puzzleId, themes, solved, hintUsed, newRating, ratingDelta, timeTakenMs, identity: explicitIdentity }) {
  const identity = explicitIdentity ?? await resolveIdentity()
  const db = await openDB()
  const profile = await getProfileFor(identity)

  const updated = {
    ...profile,
    rating: newRating,
    totalSolved: profile.totalSolved + (solved ? 1 : 0),
    totalFailed: profile.totalFailed + (solved ? 0 : 1),
    currentStreak: solved ? profile.currentStreak + 1 : 0,
    bestStreak: solved ? Math.max(profile.bestStreak, profile.currentStreak + 1) : profile.bestStreak,
  }

  // remoteId is assigned here, once, regardless of whether a session
  // exists right now -- puzzle_attempts.id is a uuid, distinct from this
  // store's own local autoincrement key, and per the original migration
  // design that local key must never be reused as the remote identity (it's
  // only unique within one browser). Generating it up front means an
  // eventual push -- whether the real-time attempt below or a much later
  // flush retry -- always reuses the same id, making retries naturally
  // idempotent via 23505-as-success (see pushAttemptIfPossible) rather than
  // ever risking a duplicate row.
  const remoteId = crypto.randomUUID()
  const attemptRecord = {
    puzzleId, themes, solved, hintUsed: !!hintUsed, ratingDelta, timeTakenMs,
    at: Date.now(), synced: false, remoteId, ownerId: identity,
  }

  const localId = await appendAttempt(db, attemptRecord)

  await Promise.all([
    bumpThemeStats(db, identity, themes, solved),
    saveProfile(updated, identity),
  ])

  // Fire-and-forget: never blocks recordAttempt's own return (rating/streak
  // updates apply immediately regardless of network state -- local-first,
  // matching this store's whole existing design), and a push failure here
  // never throws/surfaces -- it just leaves synced:false for a later
  // flushUnsyncedAttempts call to retry.
  pushAttemptIfPossible({ ...attemptRecord, id: localId }).catch(() => {})

  return updated
}

/**
 * Clears local data back to first-run defaults for ONE identity: that
 * identity's attempts/theme-stats rows removed, its profile/preferences
 * reset to the same defaults a brand-new install would have. Irreversible.
 *
 * This is no longer a whole-store `.clear()` (that would have been correct
 * pre-partitioning, when the store only ever held one identity's data at
 * all -- it is not correct now: a device can legitimately hold more than
 * one identity's data side by side, e.g. a guest interlude sitting next to
 * an already-adopted account's history, and a wholesale clear would destroy
 * both). Attempts/theme-stats use a cursor to delete only rows/keys tagged
 * with the target identity; profile/preferences are single-key-per-identity
 * writes, so overwriting that identity's key with defaults is already
 * exactly scoped.
 *
 * `identity` override: see getPreferences' doc comment -- LaunchOverlay.jsx's
 * handleDiscard needs this to target GUEST_IDENTITY explicitly, since by the
 * time Discard is reachable the active session already belongs to the new
 * account, not the guest data being discarded.
 */
export async function resetAllLocalData({ identity } = {}) {
  const activeIdentity = identity ?? await resolveIdentity()
  const db = await openDB()
  const t = tx(db, [STORE_PROFILE, STORE_ATTEMPTS, STORE_THEME_STATS, STORE_PREFERENCES], 'readwrite')

  t.objectStore(STORE_PROFILE).put({ ...DEFAULT_PROFILE }, activeIdentity)
  t.objectStore(STORE_PREFERENCES).put({ ...DEFAULT_PREFERENCES }, activeIdentity)

  const attemptsStore = t.objectStore(STORE_ATTEMPTS)
  const attemptsCursorReq = attemptsStore.openCursor()
  attemptsCursorReq.onsuccess = () => {
    const cursor = attemptsCursorReq.result
    if (!cursor) return
    if (cursor.value.ownerId === activeIdentity) cursor.delete()
    cursor.continue()
  }

  const themeStatsStore = t.objectStore(STORE_THEME_STATS)
  const themePrefix = `${activeIdentity}::`
  const themeCursorReq = themeStatsStore.openKeyCursor()
  themeCursorReq.onsuccess = () => {
    const cursor = themeCursorReq.result
    if (!cursor) return
    if (typeof cursor.key === 'string' && cursor.key.startsWith(themePrefix)) {
      themeStatsStore.delete(cursor.key)
    }
    cursor.continue()
  }

  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

// The literal key every store used before this partitioning existed --
// distinct from `identity` (Commit 1's namespacing) purely by name, so
// adoptLegacyDataIfSafe's own reads below can't be confused with an
// ordinary namespaced read. Used only by that function.
const PRE_PARTITION_KEY = 'main'

async function getLegacyRecord(db, storeName) {
  const t = tx(db, [storeName], 'readonly')
  return reqToPromise(t.objectStore(storeName).get(PRE_PARTITION_KEY))
}

// Raw, unfiltered, un-defaulted -- deliberately not getAllAttempts() (which
// both filters by identity and applies withSyncedDefault). This needs every
// row exactly as stored, including whichever ones have no `ownerId` at all.
async function getRawAttempts(db) {
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  return reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
}

// Every post-Commit-1 themeStats key is `${identity}::${theme}` -- `identity`
// is always either GUEST_IDENTITY or a Supabase auth uuid, neither of which
// contains '::', and no theme label in this app's fixed tactical lexicon
// does either, so "does this key contain '::'" reliably distinguishes an
// already-namespaced key from a legacy bare theme-name key.
async function getLegacyThemeStatsEntries(db) {
  const t = tx(db, [STORE_THEME_STATS], 'readonly')
  const store = t.objectStore(STORE_THEME_STATS)
  const keys = await reqToPromise(store.getAllKeys())
  const values = await reqToPromise(store.getAll())
  return keys
    .map((key, i) => ({ key, value: values[i] }))
    .filter(({ key }) => typeof key === 'string' && !key.includes('::'))
}

/**
 * One-time-per-device adoption of legacy (pre-Commit-1, un-namespaced) local
 * data into `identity`'s namespace. Full design trace:
 * docs/specs/storage-partitioning-investigation.md, addenda 2-4.
 *
 * No separate "done" flag: presence/absence of legacy, un-namespaced data
 * IS the idempotency signal. Once a record is adopted (copied to its new
 * namespaced key/tag and the old bare key/tag removed, in the same
 * transaction), there is nothing left for a later call to find -- calling
 * this on every boot is always correct and, once a device's legacy data has
 * actually been consumed, cheap (a few empty reads, no writes).
 *
 * `identity` is NOT resolved in here via a second, independent
 * supabase.auth.getSession() call. The caller (App.jsx's boot sequence,
 * the only intended call site) has already resolved this exactly once this
 * boot; this parameter is that already-resolved value, expressed as either
 * a real account id (a session was found) or GUEST_IDENTITY (resolution
 * genuinely completed and found none). This function must never be called
 * while resolution is still in flight -- there is no third "unconfirmed"
 * value to pass for that state; the contract is that this simply isn't
 * called yet.
 *
 * Guest-vs-stranded-account disambiguation (only relevant when identity ===
 * GUEST_IDENTITY -- a real account id is always unambiguous and adopts
 * immediately): a resolved "no session" is not, by itself, safe to treat as
 * a genuine guest. The narrow edge case this whole mitigation exists for --
 * a real account's session dying between boots (refresh fails, and the
 * access token's real expiry has already passed) -- also resolves to a
 * clean "no session," indistinguishable from an actual guest by session
 * state alone. What DOES distinguish them, checked here: does any legacy
 * attempts row have a RAW (pre-withSyncedDefault) stored `synced` value of
 * exactly `true`? That value can only ever have been set by
 * markAttemptsSynced, itself only ever reachable from a session-gated
 * caller (pushAttemptIfPossible's post-getSession()-check success branch,
 * or LaunchOverlay.jsx's already-authenticated Merge path) -- confirmed by
 * full code and git-history trace, no guest-reachable path exists that
 * produces this value. If found, this device provably was a real account
 * at some point: defer entirely (touch nothing) and wait for a future
 * confirmed boot rather than guess. If not found, proceed immediately --
 * there is no account-shaped evidence being ignored.
 *
 * @param {string} identity
 * @returns {Promise<{ adopted: boolean, deferred: boolean }>}
 */
export async function adoptLegacyDataIfSafe(identity) {
  const db = await openDB()

  const legacyProfile = await getLegacyRecord(db, STORE_PROFILE)
  const legacyPreferences = await getLegacyRecord(db, STORE_PREFERENCES)
  const legacyThemeStats = await getLegacyThemeStatsEntries(db)
  const legacyAttempts = (await getRawAttempts(db)).filter((a) => a.ownerId === undefined)

  const hasLegacyData = legacyProfile !== undefined
    || legacyPreferences !== undefined
    || legacyThemeStats.length > 0
    || legacyAttempts.length > 0

  if (!hasLegacyData) return { adopted: false, deferred: false }

  if (identity === GUEST_IDENTITY) {
    const provablyNotAGuest = legacyAttempts.some((a) => a.synced === true)
    if (provablyNotAGuest) return { adopted: false, deferred: true }
  }

  const t = tx(db, [STORE_PROFILE, STORE_ATTEMPTS, STORE_THEME_STATS, STORE_PREFERENCES], 'readwrite')

  if (legacyProfile !== undefined) {
    t.objectStore(STORE_PROFILE).put(legacyProfile, identity)
    t.objectStore(STORE_PROFILE).delete(PRE_PARTITION_KEY)
  }
  if (legacyPreferences !== undefined) {
    t.objectStore(STORE_PREFERENCES).put(legacyPreferences, identity)
    t.objectStore(STORE_PREFERENCES).delete(PRE_PARTITION_KEY)
  }

  const attemptsStore = t.objectStore(STORE_ATTEMPTS)
  for (const attempt of legacyAttempts) {
    attemptsStore.put({ ...attempt, ownerId: identity })
  }

  const themeStatsStore = t.objectStore(STORE_THEME_STATS)
  for (const { key, value } of legacyThemeStats) {
    themeStatsStore.put(value, `${identity}::${key}`)
    themeStatsStore.delete(key)
  }

  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })

  return { adopted: true, deferred: false }
}
