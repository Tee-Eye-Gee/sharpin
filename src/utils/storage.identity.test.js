import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Commit 1's own scope: real IndexedDB behavior (fake-indexeddb is a
// spec-compliant implementation, not a mock of our own code) proving the
// namespacing itself -- guest vs. account isolation, resetAllLocalData's
// scoped-not-wholesale clear, and that a legacy un-tagged row stays invisible
// until Commit 3's adoption routine exists. Deliberately does NOT touch the
// deferred-confirmation/adoption-routine behavior -- that fixture and its
// assertions belong to Commit 3's review, per the build sequencing agreed
// before this file was written. VITE_ENABLE_ACCOUNT_SYNC is 'true' for the
// whole run via vitest.config.js -- the flag-off case lives in its own file
// (storage.identity.flagOff.test.js) since it needs a different value at
// module-eval time.

const mockGetSession = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...args) => mockGetSession(...args) },
    // recordAttempt's fire-and-forget push (unrelated to what this file
    // tests) needs somewhere to land without throwing synchronously.
    from: () => ({ insert: async () => ({ error: null }) }),
  },
}))

const storage = await import('./storage.js')

function sessionOf(userId) {
  return { data: { session: userId ? { user: { id: userId } } : null } }
}

// Clears all four stores in place rather than deleting/recreating the whole
// database -- deleteDatabase() blocks on any still-open connection (storage.js
// caches its own dbPromise indefinitely and never closes it), which made an
// earlier version of this file hang in beforeEach. A plain clear() inside a
// normal transaction has none of that exclusivity requirement.
async function clearAllStores() {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('sharpin', 3)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      const d = req.result
      for (const name of ['profile', 'attempts', 'themeStats', 'preferences']) {
        if (!d.objectStoreNames.contains(name)) {
          name === 'attempts'
            ? d.createObjectStore(name, { keyPath: 'id', autoIncrement: true })
            : d.createObjectStore(name)
        }
      }
    }
  })
  await new Promise((resolve, reject) => {
    const t = db.transaction(['profile', 'attempts', 'themeStats', 'preferences'], 'readwrite')
    t.objectStore('profile').clear()
    t.objectStore('attempts').clear()
    t.objectStore('themeStats').clear()
    t.objectStore('preferences').clear()
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

beforeEach(async () => {
  mockGetSession.mockReset()
  await clearAllStores()
})

describe('storage.js identity namespacing', () => {
  it('a guest and an account on the same device never see each other\'s attempts, profile, or theme stats', async () => {
    mockGetSession.mockResolvedValue(sessionOf(null))
    await storage.recordAttempt({
      puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })

    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    const accountProfileBeforeAnyPlay = await storage.getProfile()
    expect(accountProfileBeforeAnyPlay.totalSolved).toBe(0)
    expect(accountProfileBeforeAnyPlay.rating).not.toBe(1210)
    expect(await storage.getAllAttempts()).toHaveLength(0)

    await storage.recordAttempt({
      puzzleId: 'a1', themes: ['pin'], solved: false, hintUsed: false,
      newRating: 1190, ratingDelta: -10, timeTakenMs: 900,
    })
    const accountAttempts = await storage.getAllAttempts()
    expect(accountAttempts).toHaveLength(1)
    expect(accountAttempts[0].puzzleId).toBe('a1')
    expect(await storage.getThemeStats()).toHaveProperty('pin')
    expect(await storage.getThemeStats()).not.toHaveProperty('fork')

    mockGetSession.mockResolvedValue(sessionOf(null))
    const guestAttemptsAfter = await storage.getAllAttempts()
    expect(guestAttemptsAfter).toHaveLength(1)
    expect(guestAttemptsAfter[0].puzzleId).toBe('g1')
    expect((await storage.getProfile()).rating).toBe(1210)
    expect(await storage.getThemeStats()).toHaveProperty('fork')
    expect(await storage.getThemeStats()).not.toHaveProperty('pin')
  })

  it('preferences (the fourth store) are namespaced too -- a guest\'s board theme does not leak into an account\'s, and vice versa', async () => {
    mockGetSession.mockResolvedValue(sessionOf(null))
    await storage.savePreferences({ appMode: 'dark', boardTheme: 'wood', inputMode: 'drag', lastPulledAt: null })

    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    const accountPrefsBeforeAnyChange = await storage.getPreferences()
    expect(accountPrefsBeforeAnyChange.boardTheme).toBe('tournament') // DEFAULT_PREFERENCES, not the guest's 'wood'

    await storage.savePreferences({ appMode: 'light', boardTheme: 'classic', inputMode: 'tap', lastPulledAt: '2026-01-01T00:00:00.000Z' })
    expect((await storage.getPreferences()).boardTheme).toBe('classic')

    mockGetSession.mockResolvedValue(sessionOf(null))
    const guestPrefsAfter = await storage.getPreferences()
    expect(guestPrefsAfter.boardTheme).toBe('wood') // untouched by the account's change
    expect(guestPrefsAfter.lastPulledAt).toBeNull()
  })

  it('resetAllLocalData({ identity: GUEST_IDENTITY }) clears only the guest bucket, leaving an already-adopted account untouched', async () => {
    mockGetSession.mockResolvedValue(sessionOf(null))
    await storage.recordAttempt({
      puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })

    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    await storage.recordAttempt({
      puzzleId: 'a1', themes: ['pin'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })

    await storage.resetAllLocalData({ identity: storage.GUEST_IDENTITY })

    mockGetSession.mockResolvedValue(sessionOf(null))
    expect(await storage.getAllAttempts()).toHaveLength(0)
    expect((await storage.getProfile()).totalSolved).toBe(0)
    expect(await storage.getThemeStats()).toEqual({})

    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    const accountAttempts = await storage.getAllAttempts()
    expect(accountAttempts).toHaveLength(1)
    expect((await storage.getProfile()).totalSolved).toBe(1)
    expect(await storage.getThemeStats()).toHaveProperty('pin')
  })

  it('a legacy, un-tagged attempt row (no ownerId -- pre-Commit-1 shape) is invisible to every identity until an adoption routine tags it', async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('sharpin', 3)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise((resolve, reject) => {
      const t = db.transaction(['attempts'], 'readwrite')
      t.objectStore('attempts').add({
        puzzleId: 'legacy1', themes: ['skewer'], solved: true, hintUsed: false,
        ratingDelta: 5, timeTakenMs: 500, at: Date.now(), synced: true, remoteId: 'r1',
        // deliberately no ownerId -- this is the pre-Commit-1 shape
      })
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    })
    db.close()

    mockGetSession.mockResolvedValue(sessionOf(null))
    expect(await storage.getAllAttempts()).toHaveLength(0)

    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    expect(await storage.getAllAttempts()).toHaveLength(0)
  })

  it('markAttemptsSynced with an explicit identity reassigns ownerId (the guest-to-account Merge transfer); without it, ownerId is left untouched', async () => {
    mockGetSession.mockResolvedValue(sessionOf(null))
    await storage.recordAttempt({
      puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })
    const [guestAttempt] = await storage.getAllAttempts()

    // Ordinary push-success path: no identity passed, ownerId must not move.
    await storage.markAttemptsSynced([{ id: guestAttempt.id, remoteId: guestAttempt.remoteId }])
    expect(await storage.getAllAttempts()).toHaveLength(1) // still visible as guest

    // Merge path: explicit identity reassigns ownership to the new account.
    await storage.markAttemptsSynced([{ id: guestAttempt.id }], { identity: 'acct-1' })
    expect(await storage.getAllAttempts()).toHaveLength(0) // no longer guest's

    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    const accountAttempts = await storage.getAllAttempts()
    expect(accountAttempts).toHaveLength(1)
    expect(accountAttempts[0].puzzleId).toBe('g1')
  })
})
