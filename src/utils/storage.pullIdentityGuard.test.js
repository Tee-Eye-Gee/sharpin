import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Backlog #1f -- docs/specs/pull-side-identity-race-investigation.md.
// pullRemoteAttempts and syncPreferences's pull branch each resolve
// identity/session at more than one point within one logical pull
// operation. Once Logout allows a same-page-load identity switch, the
// LATER resolution can disagree with the EARLIER one, landing a watermark
// or a pulled preferences row under the wrong identity -- a silent
// omission/misattribution, not a crash. The two functions need DIFFERENT
// fixes, not the same shape: pullRemoteAttempts' internal calls have no
// legitimate reason to re-resolve independently (pin-and-thread,
// eliminating the divergence); syncPreferences' pull branch legitimately
// needs its own fresh session (authenticating the query, handling the
// guest case), so it needs a real compare-and-abort guard instead, with a
// bounded retry rather than a silent, un-retried drop.

const mockGetSession = vi.fn()
const mockAttemptsSelectResult = vi.fn()
const mockPreferencesSelectResult = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a) },
    from: (table) => {
      if (table === 'puzzle_attempts') {
        return { select: () => ({ eq: () => ({ gt: () => mockAttemptsSelectResult() }) }) }
      }
      if (table === 'preferences') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => mockPreferencesSelectResult() }) }) }
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

async function seedAttempt(attempt) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('sharpin', 3)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  await new Promise((resolve, reject) => {
    const t = db.transaction(['attempts'], 'readwrite')
    t.objectStore('attempts').add(attempt)
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

beforeEach(async () => {
  mockGetSession.mockReset()
  mockAttemptsSelectResult.mockReset()
  mockPreferencesSelectResult.mockReset()
  await clearAllStores()
})

describe('pullRemoteAttempts -- identity pinned once, threaded through the dedup check and watermark write', () => {
  it('completes correctly under the originally-resolved identity, even if a later getSession() call would return a different one -- and never makes a second such call at all', async () => {
    await seedAttempt({
      puzzleId: 'existing1', themes: ['fork'], solved: true, hintUsed: false,
      ratingDelta: 10, timeTakenMs: 500, at: Date.now(), synced: true, remoteId: 'remote-existing-1', ownerId: 'acct-A',
    })

    mockGetSession
      .mockResolvedValueOnce(sessionOf('acct-A')) // this function's own single, top-level resolution
      .mockResolvedValue(sessionOf('acct-B')) // ANY further call (only happens if the fix regresses) would see a different identity

    mockAttemptsSelectResult.mockResolvedValue({
      data: [
        { id: 'remote-existing-1', puzzle_id: 'existing1', themes: ['fork'], solved: true, hint_used: false, rating_delta: 10, time_taken_ms: 500, attempted_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
        { id: 'remote-new-1', puzzle_id: 'new1', themes: ['pin'], solved: false, hint_used: false, rating_delta: -5, time_taken_ms: 800, attempted_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z' },
      ],
      error: null,
    })

    const result = await storage.pullRemoteAttempts()

    // Exactly 2 calls: this function's own top-level resolution, plus
    // getPreferences()'s internal one (point 2 -- deliberately left
    // auto-resolving, since it's the one gap traced as unreachable to a
    // same-page-load identity switch; see the inline comment in
    // pullRemoteAttempts). NOT 3 or 4: getAllAttempts and the watermark
    // write are both pinned/threaded now and make no getSession() call of
    // their own at all -- this count is exactly what proves that.
    expect(mockGetSession).toHaveBeenCalledTimes(2)
    expect(result.pulled).toBe(1) // the dedup check correctly recognized the existing row under A -- not under B's (empty) set

    const attemptsA = await storage.getAllAttempts({ identity: 'acct-A' })
    expect(attemptsA).toHaveLength(2) // existing + newly pulled, no duplicate
    expect(attemptsA.some((a) => a.remoteId === 'remote-new-1')).toBe(true)

    const prefsA = await storage.getPreferences({ identity: 'acct-A' })
    expect(prefsA.lastPulledAt).toBe('2026-01-03T00:00:00.000Z') // watermark advanced under A

    expect(await storage.getAllAttempts({ identity: 'acct-B' })).toHaveLength(0) // B completely untouched
    expect((await storage.getPreferences({ identity: 'acct-B' })).lastPulledAt).toBeNull()
  })
})

describe('syncPreferences pull branch -- identity re-checked before the write, retried once, deferred cleanly if still mismatched', () => {
  it('on a same-identity pull (no race), behaves exactly as before', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-A'))
    mockPreferencesSelectResult.mockResolvedValue({
      data: { app_mode: 'light', board_theme: 'wood', input_mode: 'tap', updated_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    await storage.syncPreferences()

    const prefsA = await storage.getPreferences({ identity: 'acct-A' })
    expect(prefsA.boardTheme).toBe('wood')
    expect(prefsA.preferencesUpdatedAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('a detected mismatch (identity moved A -> B between the two resolutions) retries once, fresh, and correctly pulls under whichever identity is now actually live -- A\'s record is never touched', async () => {
    mockGetSession
      .mockResolvedValueOnce(sessionOf('acct-A')) // outer call: resolveIdentity() -> identity = A
      .mockResolvedValueOnce(sessionOf('acct-B')) // outer call: pull branch's own getSession() -> mismatch vs A
      .mockResolvedValue(sessionOf('acct-B')) // the retry's own resolveIdentity() + its own getSession() -- both B, consistent

    mockPreferencesSelectResult.mockResolvedValue({
      data: { app_mode: 'dark', board_theme: 'classic', input_mode: 'drag', updated_at: '2026-03-03T00:00:00.000Z' },
      error: null,
    })

    await storage.syncPreferences()

    const prefsB = await storage.getPreferences({ identity: 'acct-B' })
    expect(prefsB.boardTheme).toBe('classic')
    expect(prefsB.preferencesUpdatedAt).toBe('2026-03-03T00:00:00.000Z')

    // The critical assertion: A's own local record must be byte-for-byte
    // untouched -- this is the exact "Account A's device shows Account B's
    // theme" corruption the guard exists to prevent.
    const prefsA = await storage.getPreferences({ identity: 'acct-A' })
    expect(prefsA.boardTheme).toBe('tournament') // default -- never overwritten with B's data
    expect(prefsA.preferencesUpdatedAt).toBeNull()
  })

  it('when identity keeps changing across the retry too, defers cleanly to the next trigger instead of looping -- no write anywhere, no hang', async () => {
    mockGetSession
      .mockResolvedValueOnce(sessionOf('acct-A')) // attempt 1: resolveIdentity()
      .mockResolvedValueOnce(sessionOf('acct-B')) // attempt 1: pull branch getSession() -- mismatch, triggers the one retry
      .mockResolvedValueOnce(sessionOf('acct-C')) // attempt 2 (retry): resolveIdentity()
      .mockResolvedValueOnce(sessionOf('acct-D')) // attempt 2 (retry): pull branch getSession() -- mismatch again, retries exhausted

    await expect(storage.syncPreferences()).resolves.toBeUndefined()

    expect(mockGetSession).toHaveBeenCalledTimes(4) // exactly 2 attempts, 2 calls each -- bounded, never more
    expect(mockPreferencesSelectResult).not.toHaveBeenCalled() // never even reached the remote query on either attempt
    for (const id of ['acct-A', 'acct-B', 'acct-C', 'acct-D']) {
      const prefs = await storage.getPreferences({ identity: id })
      expect(prefs.boardTheme).toBe('tournament') // untouched, for every identity involved
    }
  })
})
