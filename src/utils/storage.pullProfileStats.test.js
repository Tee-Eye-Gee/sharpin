import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Backlog #1g (docs/specs/guest-merge-profile-migration-investigation.md):
// pullProfileStats' own mechanism-level correctness, against real
// (fake-indexeddb) IndexedDB, mocking only the Supabase network boundary --
// same posture as storage.preferencesSync.test.js for the analogous
// preferences pull.

const mockGetSession = vi.fn()
const mockProfileStatsSelect = vi.fn()
const mockThemeStatsSelect = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a) },
    from: (table) => {
      if (table === 'profile_stats') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => mockProfileStatsSelect() }) }) }
      }
      if (table === 'theme_stats') {
        return { select: () => ({ eq: () => mockThemeStatsSelect() }) }
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
  mockProfileStatsSelect.mockReset()
  mockThemeStatsSelect.mockReset()
  await clearAllStores()
})

describe('pullProfileStats -- unconditional overwrite of local profile/themeStats from server aggregates', () => {
  it('second-device case: no local record exists yet -- populates profile and themeStats from the server rows', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    mockProfileStatsSelect.mockResolvedValue({
      data: { rating: 1274, current_streak: 5, best_streak: 5, total_solved: 5, total_failed: 0 },
      error: null,
    })
    mockThemeStatsSelect.mockResolvedValue({
      data: [
        { theme: 'fork', attempts: 3, solved: 2 },
        { theme: 'mate', attempts: 2, solved: 2 },
      ],
      error: null,
    })

    await storage.pullProfileStats()

    const profile = await storage.getProfile()
    expect(profile).toEqual({ rating: 1274, totalSolved: 5, totalFailed: 0, currentStreak: 5, bestStreak: 5 })
    const themeStats = await storage.getThemeStats()
    expect(themeStats).toEqual({ fork: { attempts: 3, solved: 2 }, mate: { attempts: 2, solved: 2 } })
  })

  it('unconditionally overwrites an existing local value -- no comparison, no guard, by design (confirmed, not assumed: profile_stats/theme_stats have no locally-pending-edit concept to protect)', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('sharpin', 3)
      req.onsuccess = () => resolve(req.result)
    })
    await new Promise((resolve, reject) => {
      const t = db.transaction(['profile', 'themeStats'], 'readwrite')
      t.objectStore('profile').put({ rating: 1200, totalSolved: 0, totalFailed: 0, currentStreak: 0, bestStreak: 0 }, 'acct-1')
      t.objectStore('themeStats').put({ attempts: 99, solved: 1 }, 'acct-1::fork') // deliberately stale/wrong
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    })
    db.close()

    mockProfileStatsSelect.mockResolvedValue({
      data: { rating: 1274, current_streak: 5, best_streak: 5, total_solved: 5, total_failed: 0 },
      error: null,
    })
    mockThemeStatsSelect.mockResolvedValue({ data: [{ theme: 'fork', attempts: 3, solved: 2 }], error: null })

    await storage.pullProfileStats()

    const profile = await storage.getProfile()
    expect(profile.rating).toBe(1274)
    expect(profile.totalSolved).toBe(5)
    const themeStats = await storage.getThemeStats()
    expect(themeStats.fork).toEqual({ attempts: 3, solved: 2 }) // overwritten outright, not merged with the stale 99/1
  })

  it('no profile_stats row exists yet for this identity: safe no-op, not an error, local state untouched', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    mockProfileStatsSelect.mockResolvedValue({ data: null, error: null })

    // Still a no-op locally, but now reports success: "the server has no
    // stats for this identity" is a known state, so DEFAULT_PROFILE is the
    // correct profile to compute ratings from (Backlog #1d readiness signal).
    await expect(storage.pullProfileStats()).resolves.toEqual({ identity: 'acct-1', ok: true })
    expect(mockThemeStatsSelect).not.toHaveBeenCalled() // never even reaches the theme_stats query
    const profile = await storage.getProfile()
    expect(profile.rating).toBe(1200) // DEFAULT_PROFILE, untouched
  })

  it('makes zero Supabase calls when there is no session', async () => {
    mockGetSession.mockResolvedValue(sessionOf(null))
    await storage.pullProfileStats()
    expect(mockProfileStatsSelect).not.toHaveBeenCalled()
    expect(mockThemeStatsSelect).not.toHaveBeenCalled()
  })
})

describe('the adversarial case: guest history present locally, rating/streaks/themeStats correct pre-merge -- confirm they survive Merge post-fix', () => {
  it('a new account\'s local profile/themeStats, after Merge + pullProfileStats, exactly match the guest\'s pre-merge values', async () => {
    // Phase 1: build real guest history via the real, unmocked recordAttempt
    // -- no session yet, so this lands under GUEST_IDENTITY exactly as an
    // actual guest's play would (its own fire-and-forget push no-ops with no
    // session, so no unexpected supabase.from('puzzle_attempts') call here).
    mockGetSession.mockResolvedValue(sessionOf(null))
    await storage.recordAttempt({
      puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })
    await storage.recordAttempt({
      puzzleId: 'g2', themes: ['fork', 'mate'], solved: false, hintUsed: false,
      newRating: 1195, ratingDelta: -15, timeTakenMs: 1500,
    })
    const guestProfile = await storage.getProfile()
    const guestThemeStats = await storage.getThemeStats()
    // Sanity-check the baseline itself is non-trivial before trusting the
    // comparison below.
    expect(guestProfile.totalSolved).toBe(1)
    expect(guestProfile.totalFailed).toBe(1)
    expect(guestThemeStats.fork).toEqual({ attempts: 2, solved: 1 })

    // Phase 2: Merge has already run (migrateGuestDataToAccount's own,
    // separately-tested attempts/preferences migration -- not re-tested
    // here) and recompute_stats() has already recomputed the server-side
    // aggregate from those exact same two attempts. Model that server state
    // directly, matching the guest baseline above (this is the real-world
    // guarantee recompute_stats() provides, confirmed by direct SQL read in
    // the investigation -- not re-derived here, which would just be
    // reimplementing a Postgres RPC in JS).
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    mockProfileStatsSelect.mockResolvedValue({
      data: {
        rating: guestProfile.rating,
        current_streak: guestProfile.currentStreak,
        best_streak: guestProfile.bestStreak,
        total_solved: guestProfile.totalSolved,
        total_failed: guestProfile.totalFailed,
      },
      error: null,
    })
    mockThemeStatsSelect.mockResolvedValue({
      data: Object.entries(guestThemeStats).map(([theme, s]) => ({ theme, attempts: s.attempts, solved: s.solved })),
      error: null,
    })

    // Phase 3: the fix under test -- what App.jsx's runSyncSequence now
    // calls right after Merge's onAuthenticated transition.
    await storage.pullProfileStats()

    const acctProfile = await storage.getProfile()
    expect(acctProfile).toEqual(guestProfile)
    const acctThemeStats = await storage.getThemeStats()
    expect(acctThemeStats).toEqual(guestThemeStats)
  })
})
