import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Commit 3's own scope: adoptLegacyDataIfSafe, exercised directly against
// real (fake-indexeddb) IndexedDB with hand-seeded pre-Commit-1-shaped data.
// This file never calls supabase.auth.getSession() at all -- the function
// under test takes an already-resolved `identity` as a plain argument by
// design (see its doc comment), so the real-session/real-auth-js precondition
// belongs in storage.adoption.realSessionFixture.test.js, not here. The
// supabase module is still mocked purely because storage.js imports it at
// module scope for its OTHER exports; unmocked, the real supabaseClient.js
// would throw on missing env vars in this test environment.

vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) }, from: () => ({}) },
}))

const storage = await import('./storage.js')

async function openRawDb() {
  return new Promise((resolve, reject) => {
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
}

async function clearAllStores() {
  const db = await openRawDb()
  await new Promise((resolve, reject) => {
    const t = db.transaction(['profile', 'attempts', 'themeStats', 'preferences'], 'readwrite')
    for (const name of ['profile', 'attempts', 'themeStats', 'preferences']) t.objectStore(name).clear()
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

// Seeds exactly the pre-Commit-1 shape: bare 'main' keys, untagged attempts
// (no ownerId field at all), bare theme-name keys -- not storage.js's own
// (already-namespaced) write paths.
async function seedLegacyData({ attemptsSynced = [false] } = {}) {
  const db = await openRawDb()
  await new Promise((resolve, reject) => {
    const t = db.transaction(['profile', 'attempts', 'themeStats', 'preferences'], 'readwrite')
    t.objectStore('profile').put({ rating: 1350, totalSolved: 7, totalFailed: 2, currentStreak: 3, bestStreak: 5 }, 'main')
    t.objectStore('preferences').put({ appMode: 'light', boardTheme: 'wood', inputMode: 'tap', lastPulledAt: null }, 'main')
    attemptsSynced.forEach((synced, i) => {
      const attempt = { puzzleId: `legacy${i}`, themes: ['fork'], solved: true, hintUsed: false, ratingDelta: 10, timeTakenMs: 500, at: Date.now() }
      if (synced !== undefined) attempt.synced = synced
      t.objectStore('attempts').add(attempt)
    })
    t.objectStore('themeStats').put({ attempts: 7, solved: 5 }, 'fork')
    t.objectStore('themeStats').put({ attempts: 2, solved: 1 }, 'pin')
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

beforeEach(async () => {
  await clearAllStores()
})

describe('adoptLegacyDataIfSafe', () => {
  it('does nothing and reports no-op when there is no legacy data at all', async () => {
    const result = await storage.adoptLegacyDataIfSafe('acct-1')
    expect(result).toEqual({ adopted: false, deferred: false })
  })

  it('adopts every store into a real account id unconditionally -- no synced-flag check applies to a confirmed account identity', async () => {
    await seedLegacyData({ attemptsSynced: [true] }) // even WITH synced:true evidence, a real identity adopts immediately
    const result = await storage.adoptLegacyDataIfSafe('acct-1')
    expect(result).toEqual({ adopted: true, deferred: false })

    // Direct, identity-explicit checks (bypassing resolveIdentity()/getSession() entirely):
    const rawProfile = await new Promise((resolve) => {
      openRawDb().then((db) => {
        const t = db.transaction(['profile'], 'readonly')
        const req = t.objectStore('profile').get('acct-1')
        req.onsuccess = () => resolve(req.result)
      })
    })
    expect(rawProfile).toEqual({ rating: 1350, totalSolved: 7, totalFailed: 2, currentStreak: 3, bestStreak: 5 })

    const attempts = await storage.getAllAttempts({ identity: 'acct-1' })
    expect(attempts).toHaveLength(1)
    expect(attempts[0].puzzleId).toBe('legacy0')

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.boardTheme).toBe('wood')

    // getThemeStats has no identity override (never needed one -- only
    // LaunchOverlay.jsx's guest-migration path needed that, and it never
    // touches theme stats), so check the namespaced compound key directly.
    const db = await openRawDb()
    const rawForkStats = await new Promise((resolve) => {
      const req = db.transaction(['themeStats'], 'readonly').objectStore('themeStats').get('acct-1::fork')
      req.onsuccess = () => resolve(req.result)
    })
    expect(rawForkStats).toEqual({ attempts: 7, solved: 5 })
    db.close()
  })

  it('the OLD bare keys are gone after adoption -- not just copied, actually removed', async () => {
    await seedLegacyData()
    await storage.adoptLegacyDataIfSafe('acct-1')

    const db = await openRawDb()
    const stillThere = await Promise.all([
      new Promise((resolve) => {
        const req = db.transaction(['profile'], 'readonly').objectStore('profile').get('main')
        req.onsuccess = () => resolve(req.result)
      }),
      new Promise((resolve) => {
        const req = db.transaction(['preferences'], 'readonly').objectStore('preferences').get('main')
        req.onsuccess = () => resolve(req.result)
      }),
      new Promise((resolve) => {
        const req = db.transaction(['themeStats'], 'readonly').objectStore('themeStats').get('fork')
        req.onsuccess = () => resolve(req.result)
      }),
    ])
    expect(stillThere).toEqual([undefined, undefined, undefined])
    db.close()
  })

  it('proceeds immediately into GUEST_IDENTITY when no legacy attempts row has raw synced === true', async () => {
    await seedLegacyData({ attemptsSynced: [false, undefined] }) // false, and pre-v3 (field absent) -- neither is positive evidence
    const result = await storage.adoptLegacyDataIfSafe(storage.GUEST_IDENTITY)
    expect(result).toEqual({ adopted: true, deferred: false })

    const attempts = await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })
    expect(attempts).toHaveLength(2)
  })

  it('defers -- touches nothing -- when a legacy attempts row has raw synced === true, even though session resolved to no session', async () => {
    await seedLegacyData({ attemptsSynced: [false, true] }) // the true row is what must trigger deferral
    const result = await storage.adoptLegacyDataIfSafe(storage.GUEST_IDENTITY)
    expect(result).toEqual({ adopted: false, deferred: true })

    // Nothing touched: still invisible under GUEST_IDENTITY (Commit 1's own
    // guarantee for untagged legacy rows) AND the raw legacy data is intact.
    expect(await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })).toHaveLength(0)
    const db = await openRawDb()
    const rawProfile = await new Promise((resolve) => {
      const req = db.transaction(['profile'], 'readonly').objectStore('profile').get('main')
      req.onsuccess = () => resolve(req.result)
    })
    expect(rawProfile).toBeTruthy()
    db.close()
  })

  it('is idempotent across two consecutive boots -- a second call after a successful adoption finds nothing left, no double-counting or duplication', async () => {
    await seedLegacyData({ attemptsSynced: [false, false] })

    const first = await storage.adoptLegacyDataIfSafe('acct-1')
    expect(first).toEqual({ adopted: true, deferred: false })

    const second = await storage.adoptLegacyDataIfSafe('acct-1')
    expect(second).toEqual({ adopted: false, deferred: false }) // nothing legacy left to find

    // Exactly the original two rows -- not four.
    const attempts = await storage.getAllAttempts({ identity: 'acct-1' })
    expect(attempts).toHaveLength(2)
  })

  it('boot 1 (deferred) followed by boot 2 (confirmed) adopts exactly once -- the deferred boot never partially consumed anything for boot 2 to duplicate', async () => {
    await seedLegacyData({ attemptsSynced: [true] }) // provably-an-account evidence

    const boot1 = await storage.adoptLegacyDataIfSafe(storage.GUEST_IDENTITY)
    expect(boot1).toEqual({ adopted: false, deferred: true })
    expect(await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })).toHaveLength(0)

    const boot2 = await storage.adoptLegacyDataIfSafe('acct-1')
    expect(boot2).toEqual({ adopted: true, deferred: false })
    const attempts = await storage.getAllAttempts({ identity: 'acct-1' })
    expect(attempts).toHaveLength(1)
  })
})
