import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Backlog #2 -- docs/specs/logout-investigation.md §2. Confirms the actual
// mechanism Logout uses (supabase.auth.signOut(), which makes the NEXT
// getSession() call resolve session: null) is safe to fire with a push
// genuinely in flight, WITHOUT a flush-before-logout step -- distinct from
// storage.pushIdentityGuard.test.js's own A -> B (different real account)
// scenario, which exercises the NEW identity-pinning guard specifically.
// This scenario exercises the PRE-EXISTING `if (!session) return` guard
// under the exact trigger Logout actually uses, since that guard runs
// BEFORE the identity-pinning guard and is what a push racing a genuine
// signOut() (not an A -> B account switch) actually hits.

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

describe('logout mid-push (attempts): signOut() while a push is genuinely in flight', () => {
  it('the push safely no-ops via the pre-existing no-session guard -- no corrupted or orphaned state', async () => {
    let resolvePushSession
    mockGetSession
      .mockResolvedValueOnce(sessionOf('acct-A')) // recordAttempt's own resolveIdentity()
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePushSession = resolve })) // the push's own getSession()

    await storage.recordAttempt({
      puzzleId: 'p1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })

    // The exact mechanism Logout uses: by the time the in-flight push's own
    // session check resolves, signOut() has already run -- session is null,
    // not switched to a different account.
    resolvePushSession(sessionOf(null))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockAttemptsInsert).not.toHaveBeenCalled() // no network write at all
    const [attempt] = await storage.getAllAttempts({ identity: 'acct-A' })
    expect(attempt.synced).toBe(false) // left exactly as if the push hadn't run -- not corrupted, not orphaned
    expect(attempt.ownerId).toBe('acct-A') // ownership untouched

    // Recovery: a later correctly-scoped flush (e.g. a fresh login to A
    // again) still lands it correctly -- nothing was permanently lost.
    mockGetSession.mockResolvedValue(sessionOf('acct-A'))
    mockAttemptsInsert.mockResolvedValue({ error: null })
    await storage.flushUnsyncedAttempts()
    const [recovered] = await storage.getAllAttempts({ identity: 'acct-A' })
    expect(recovered.synced).toBe(true)
  })
})

describe('logout mid-push (preferences): signOut() while a push is genuinely in flight', () => {
  it('the push safely no-ops via the pre-existing no-session guard -- the local record stays pending, no network write happens', async () => {
    let resolvePushSession
    mockGetSession
      .mockResolvedValueOnce(sessionOf('acct-A')) // updatePreferences' own resolveIdentity()
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePushSession = resolve })) // the push's own getSession()

    await storage.updatePreferences({ boardTheme: 'wood' })

    resolvePushSession(sessionOf(null)) // signOut() already ran by the time this resolves
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockPreferencesUpsert).not.toHaveBeenCalled()
    const prefs = await storage.getPreferences({ identity: 'acct-A' })
    expect(prefs.synced).toBe(false) // left exactly as if the push hadn't run
    expect(prefs.boardTheme).toBe('wood') // the local write itself (pre-push) is untouched -- local-first still holds
  })
})
