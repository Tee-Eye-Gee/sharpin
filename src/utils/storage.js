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
const PROFILE_KEY = 'main'
const PREFERENCES_KEY = 'main'

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

/**
 * Load the user's profile (rating, streaks, solve counts), creating a
 * default one if this is a first run.
 */
export async function getProfile() {
  const db = await openDB()
  const t = tx(db, [STORE_PROFILE], 'readonly')
  const result = await reqToPromise(t.objectStore(STORE_PROFILE).get(PROFILE_KEY))
  return result ?? { ...DEFAULT_PROFILE }
}

async function saveProfile(profile) {
  const db = await openDB()
  const t = tx(db, [STORE_PROFILE], 'readwrite')
  t.objectStore(STORE_PROFILE).put(profile, PROFILE_KEY)
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
}

/**
 * Load the user's app-mode/board-theme/input-mode preferences, creating the
 * defaults if this is a first run. Merges over DEFAULT_PREFERENCES rather
 * than returning a stored record as-is, so a key added after a user's first
 * visit (e.g. inputMode) still resolves to its default on their existing,
 * older-shaped record instead of coming back undefined.
 */
export async function getPreferences() {
  const db = await openDB()
  const t = tx(db, [STORE_PREFERENCES], 'readonly')
  const result = await reqToPromise(t.objectStore(STORE_PREFERENCES).get(PREFERENCES_KEY))
  return { ...DEFAULT_PREFERENCES, ...result }
}

export async function savePreferences(preferences) {
  const db = await openDB()
  const t = tx(db, [STORE_PREFERENCES], 'readwrite')
  t.objectStore(STORE_PREFERENCES).put(preferences, PREFERENCES_KEY)
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

/**
 * Per-theme accuracy: { [theme]: { attempts, solved } }
 */
export async function getThemeStats() {
  const db = await openDB()
  const t = tx(db, [STORE_THEME_STATS], 'readonly')
  const store = t.objectStore(STORE_THEME_STATS)
  const keys = await reqToPromise(store.getAllKeys())
  const values = await reqToPromise(store.getAll())
  const stats = {}
  keys.forEach((key, i) => { stats[key] = values[i] })
  return stats
}

async function bumpThemeStats(db, themes, solved) {
  const t = tx(db, [STORE_THEME_STATS], 'readwrite')
  const store = t.objectStore(STORE_THEME_STATS)
  for (const theme of themes) {
    const existing = await reqToPromise(store.get(theme))
    const current = existing ?? { attempts: 0, solved: 0 }
    current.attempts += 1
    if (solved) current.solved += 1
    store.put(current, theme)
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

/**
 * Most recent N attempts, newest first — used to weight puzzle selection
 * away from themes the user has just seen.
 */
export async function getRecentAttempts(limit = 15) {
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  const all = await reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
  return all.slice(-limit).reverse().map((a) => withSyncedDefault(withHintUsedDefault(a)))
}

/**
 * The full attempt history, newest first — used by the rule-based coach to
 * find each theme's most recent occurrences regardless of how far back they
 * fall (a rare theme's last 10 attempts may be older than any fixed window).
 */
export async function getAllAttempts() {
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  const all = await reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
  return all.slice().reverse().map((a) => withSyncedDefault(withHintUsedDefault(a)))
}

/**
 * Every locally-stored attempt not yet confirmed pushed to puzzle_attempts --
 * the retry queue flushUnsyncedAttempts() below drains. Each record's own
 * `id` (the local autoincrement key) is what markAttemptSynced needs to
 * update the right row back; `remoteId` is the row's separate, stable
 * identity in Supabase (see recordAttempt's own comment for why these are
 * two different values).
 */
export async function getUnsyncedAttempts() {
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  const all = await reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
  return all.map((a) => withSyncedDefault(withHintUsedDefault(a))).filter((a) => !a.synced)
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
 * STORE_ATTEMPTS is an in-line-keyed store ({ keyPath: 'id', autoIncrement:
 * true }) -- unlike the other three stores (out-of-line, no keyPath), its
 * key lives INSIDE the stored object itself. put() on an in-line-keyed
 * store must be called with no second key argument (that's only valid for
 * out-of-line stores) -- the key is derived from the object's own `id`
 * field, which `existing` already carries from the read below.
 */
export async function markAttemptsSynced(entries) {
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readwrite')
  const store = t.objectStore(STORE_ATTEMPTS)
  for (const { id, remoteId } of entries) {
    const existing = await reqToPromise(store.get(id))
    if (!existing) continue
    store.put({ ...existing, remoteId: remoteId ?? existing.remoteId, synced: true })
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
 */
async function pushAttemptIfPossible(attempt) {
  if (!ACCOUNT_SYNC_ENABLED) return

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

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
 * (offline, a dropped connection mid-request, etc.). NOT wired to any
 * trigger yet: the login/foreground pull-push-recompute sequence that calls
 * this is a separate, later piece of this build. Safe to call with the
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
 * client-set at solve time; a delayed flushUnsyncedAttempts retry (Commit 1)
 * can insert a row whose attempted_at is well before a watermark that has
 * already advanced past it, silently skipping that row forever. updated_at
 * is server-set via puzzle_attempts_set_updated_at (`before insert or
 * update`, stamps now()) -- confirmed by reading the schema directly, this
 * column already exists for exactly this purpose (its own migration comment
 * calls it "the server-set LWW conflict-resolution timestamp"), and no
 * client code path ever UPDATEs a puzzle_attempts row after insert, so it
 * behaves as a pure insertion timestamp in practice. No new migration was
 * needed.
 *
 * Dedupes fetched rows against remoteIds already present locally before
 * inserting -- required, not just defensive: a row this same device already
 * pushed (Commit 1) can still fall after the last pull's watermark and
 * reappear in this query. Without the dedupe it would be inserted a second
 * time under a new local autoincrement key.
 *
 * Every inserted row is written with synced: true immediately -- an
 * unflagged pulled row risks being swept into flushUnsyncedAttempts and
 * causing a duplicate-key (23505) conflict on re-push.
 *
 * Not wired to any trigger yet (Commit 4 wires this into the login/
 * foreground sequence).
 */
export async function pullRemoteAttempts() {
  if (!ACCOUNT_SYNC_ENABLED) return { pulled: 0 }

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { pulled: 0 }

  const prefs = await getPreferences()
  const watermark = prefs.lastPulledAt ?? '1970-01-01T00:00:00.000Z'

  const { data, error } = await supabase
    .from('puzzle_attempts')
    .select('id, puzzle_id, themes, solved, hint_used, rating_delta, time_taken_ms, attempted_at, updated_at')
    .eq('profile_id', session.user.id)
    .gt('updated_at', watermark)

  if (error) return { pulled: 0 }
  // Nothing to advance past -- leave last_pulled_at untouched rather than
  // re-stamping it to "now": with no rows to anchor to, that would risk
  // skipping ahead of a row committed server-side after this query ran but
  // before the watermark write, the same class of race this design exists
  // to avoid on the push side.
  if (data.length === 0) return { pulled: 0 }

  const existingRemoteIds = new Set((await getAllAttempts()).map((a) => a.remoteId))
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
  await savePreferences({ ...prefs, lastPulledAt: maxUpdatedAt })

  return { pulled: newRows.length }
}

/**
 * Record a completed puzzle attempt: updates the attempt log, per-theme
 * accuracy, and the rolling profile (rating/streak/counts) in one place.
 *
 * @param {object} params
 * @param {string} params.puzzleId
 * @param {string[]} params.themes
 * @param {boolean} params.solved
 * @param {boolean} params.hintUsed
 * @param {number} params.newRating
 * @param {number} params.ratingDelta
 * @param {number} params.timeTakenMs
 * @returns {Promise<object>} the updated profile
 */
export async function recordAttempt({ puzzleId, themes, solved, hintUsed, newRating, ratingDelta, timeTakenMs }) {
  const db = await openDB()
  const profile = await getProfile()

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
    at: Date.now(), synced: false, remoteId,
  }

  const localId = await appendAttempt(db, attemptRecord)

  await Promise.all([
    bumpThemeStats(db, themes, solved),
    saveProfile(updated),
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
 * Clears all local guest data back to first-run defaults: attempts and
 * theme_stats emptied, profile and preferences reset to the same defaults
 * a brand-new install would have (DEFAULT_PROFILE / DEFAULT_PREFERENCES --
 * reusing the existing default-value constants rather than inventing new
 * ones). Irreversible.
 *
 * Guest-to-account migration's Discard path (Sub-build B2b): called only
 * after the user explicitly chooses to discard local history in favor of
 * a newly-created, empty remote account -- this makes local state match
 * that empty account exactly. Single readwrite transaction spanning all
 * four stores so the reset is atomic (no possibility of, e.g., attempts
 * clearing but preferences surviving on an interrupted write).
 */
export async function resetAllLocalData() {
  const db = await openDB()
  const t = tx(db, [STORE_PROFILE, STORE_ATTEMPTS, STORE_THEME_STATS, STORE_PREFERENCES], 'readwrite')
  t.objectStore(STORE_PROFILE).put({ ...DEFAULT_PROFILE }, PROFILE_KEY)
  t.objectStore(STORE_ATTEMPTS).clear()
  t.objectStore(STORE_THEME_STATS).clear()
  t.objectStore(STORE_PREFERENCES).put({ ...DEFAULT_PREFERENCES }, PREFERENCES_KEY)
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
