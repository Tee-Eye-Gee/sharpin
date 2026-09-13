import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Backlog #1e -- docs/specs/identity-pinned-push-guard-investigation.md.
// pushAttemptIfPossible/pushPreferencesIfPossible each resolve session
// fresh, at execution time, to authenticate their network call -- but the
// data being pushed was queued under whichever identity was active back at
// initiation time. Once Logout allows a same-page-load identity switch, a
// still-in-flight push can resolve its own getSession() call AFTER that
// switch, and (without the guard under test here) would insert/upsert the
// old identity's data under the NEW identity's profile_id. Every test below
// controls that exact interleaving deterministically (a manually-resolved
// mock promise for the push's own getSession() call), not incidental
// timing -- same technique already established in
// storage.preferencesOutOfOrder.test.js.

const mockGetSession = vi.fn()
const mockAttemptsInsert = vi.fn()
const mockPreferencesUpsert = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a) },
    from: (table) => {
      if (table === 'puzzle_attempts') {
        return { insert: (row) => mockAttemptsInsert(row) }
      }
      if (table === 'preferences') {
        return {
          upsert: (row) => ({ select: () => ({ single: () => mockPreferencesUpsert(row) }) }),
        }
      }
      throw new Error(`unexpected supabase.from('${table}') in this test`)
    },
  },
}))

const storage = await import('./storage.js')

function sessionOf(userId) {
  return { data: { session: userId ? { user: { id: userId } } : null } }
}

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
    for (const name of ['profile', 'attempts', 'themeStats', 'preferences']) t.objectStore(name).clear()
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

beforeEach(async () => {
  mockGetSession.mockReset()
  mockAttemptsInsert.mockReset()
  mockPreferencesUpsert.mockReset()
  await clearAllStores()
})

describe('pushAttemptIfPossible -- identity-pinned guard', () => {
  it('a same-identity push (no race) still succeeds normally', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-A'))
    mockAttemptsInsert.mockResolvedValue({ error: null })

    await storage.recordAttempt({
      puzzleId: 'p1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })

    await vi.waitFor(async () => {
      const [attempt] = await storage.getAllAttempts({ identity: 'acct-A' })
      expect(attempt.synced).toBe(true)
    })
    expect(mockAttemptsInsert).toHaveBeenCalledTimes(1)
    expect(mockAttemptsInsert.mock.calls[0][0].profile_id).toBe('acct-A')
  })

  it('aborts before the insert when identity moved on (A -> B) while the push was in flight -- no cross-account write, A\'s row stays retryable', async () => {
    let resolvePushSession
    mockGetSession
      .mockResolvedValueOnce(sessionOf('acct-A')) // recordAttempt's own resolveIdentity()
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePushSession = resolve })) // pushAttemptIfPossible's own getSession()

    await storage.recordAttempt({
      puzzleId: 'p1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })

    // By the time the in-flight push's own session check finally resolves,
    // a DIFFERENT account is live -- simulating a same-page-load A -> B
    // identity switch that completed while this push was still pending.
    resolvePushSession(sessionOf('acct-B'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockAttemptsInsert).not.toHaveBeenCalled() // guard aborted before any network write
    const [attemptA] = await storage.getAllAttempts({ identity: 'acct-A' })
    expect(attemptA.synced).toBe(false) // still correctly pending under its real owner
    expect(await storage.getAllAttempts({ identity: 'acct-B' })).toHaveLength(0) // B untouched
  })

  it('closes the narrower guest-to-account direction: a guest attempt\'s stray push never lands under whatever account is logging in', async () => {
    let resolvePushSession
    mockGetSession
      .mockResolvedValueOnce(sessionOf(null)) // recordAttempt's own resolveIdentity() -- genuine guest
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePushSession = resolve })) // the push's own getSession()

    await storage.recordAttempt({
      puzzleId: 'g1', themes: ['pin'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })

    // The push's own session check resolves AFTER Create Account/Login has
    // completed elsewhere on the page -- a real account is now live.
    resolvePushSession(sessionOf('acct-new'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockAttemptsInsert).not.toHaveBeenCalled()
    const [guestAttempt] = await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })
    expect(guestAttempt.synced).toBe(false)
    expect(await storage.getAllAttempts({ identity: 'acct-new' })).toHaveLength(0)
  })
})

describe('pushPreferencesIfPossible -- identity-pinned guard', () => {
  it('a same-identity push (no race) still succeeds normally', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-A'))
    mockPreferencesUpsert.mockResolvedValue({ data: { updated_at: '2026-01-01T00:00:00.000Z' }, error: null })

    await storage.updatePreferences({ boardTheme: 'wood' })

    await vi.waitFor(async () => {
      const prefs = await storage.getPreferences({ identity: 'acct-A' })
      expect(prefs.synced).toBe(true)
    })
    expect(mockPreferencesUpsert).toHaveBeenCalledTimes(1)
    expect(mockPreferencesUpsert.mock.calls[0][0].profile_id).toBe('acct-A')
  })

  it('aborts before the upsert when identity moved on (A -> B) -- B\'s real settings are never overwritten by A\'s stale values', async () => {
    // Establish B's own, different, already-synced settings first -- this
    // is exactly what a stray cross-account write would otherwise clobber.
    mockGetSession.mockResolvedValue(sessionOf('acct-B'))
    await storage.savePreferences({
      appMode: 'light', boardTheme: 'classic', inputMode: 'tap',
      lastPulledAt: null, synced: true, preferencesUpdatedAt: '2025-01-01T00:00:00.000Z', pendingToken: null,
    })

    let resolvePushSession
    mockGetSession
      .mockResolvedValueOnce(sessionOf('acct-A')) // updatePreferences' own resolveIdentity()
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePushSession = resolve })) // the push's own getSession()

    await storage.updatePreferences({ boardTheme: 'wood' })

    resolvePushSession(sessionOf('acct-B')) // identity has moved on to B by the time the push executes
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockPreferencesUpsert).not.toHaveBeenCalled() // guard aborted before any network write
    const prefsA = await storage.getPreferences({ identity: 'acct-A' })
    expect(prefsA.synced).toBe(false) // still correctly pending under its real owner
    const prefsB = await storage.getPreferences({ identity: 'acct-B' })
    expect(prefsB.boardTheme).toBe('classic') // B's real settings, completely untouched
  })
})
