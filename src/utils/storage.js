import { DEFAULT_RATING } from './rating'

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

/**
 * Most recent N attempts, newest first — used to weight puzzle selection
 * away from themes the user has just seen.
 */
export async function getRecentAttempts(limit = 15) {
  const db = await openDB()
  const t = tx(db, [STORE_ATTEMPTS], 'readonly')
  const all = await reqToPromise(t.objectStore(STORE_ATTEMPTS).getAll())
  return all.slice(-limit).reverse().map(withHintUsedDefault)
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
  return all.slice().reverse().map(withHintUsedDefault)
}

async function appendAttempt(db, attempt) {
  const t = tx(db, [STORE_ATTEMPTS], 'readwrite')
  t.objectStore(STORE_ATTEMPTS).add(attempt)
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
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

  await Promise.all([
    appendAttempt(db, { puzzleId, themes, solved, hintUsed: !!hintUsed, ratingDelta, timeTakenMs, at: Date.now() }),
    bumpThemeStats(db, themes, solved),
    saveProfile(updated),
  ])

  return updated
}
