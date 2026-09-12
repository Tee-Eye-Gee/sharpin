import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Commit 2's own scope: syncPreferences' mutually-exclusive push-if-
// unsynced/else-pull-if-newer branch logic, against real (fake-indexeddb)
// IndexedDB, mocking only the Supabase network boundary.

const mockGetSession = vi.fn()
const mockUpsertResult = vi.fn()
const mockSelectResult = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a) },
    from: (table) => {
      if (table !== 'preferences') throw new Error(`unexpected supabase.from('${table}') in this test`)
      return {
        upsert: (row) => ({ select: () => ({ single: () => mockUpsertResult(row) }) }),
        select: () => ({ eq: () => ({ maybeSingle: () => mockSelectResult() }) }),
      }
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
  mockUpsertResult.mockReset()
  mockSelectResult.mockReset()
  await clearAllStores()
})

describe('syncPreferences -- mutually exclusive push-if-unsynced / else pull-if-newer', () => {
  it('local synced, server has a newer row: pulls and applies it, advancing preferencesUpdatedAt', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    // Establish a known-synced local baseline first. savePreferences auto-
    // resolves identity via the already-mocked getSession() -- no override
    // param exists on it (only the getters take one).
    await storage.savePreferences({
      appMode: 'dark', boardTheme: 'tournament', inputMode: 'drag',
      lastPulledAt: null, synced: true, preferencesUpdatedAt: '2026-01-01T00:00:00.000Z',
    })

    mockSelectResult.mockResolvedValue({
      data: { app_mode: 'light', board_theme: 'wood', input_mode: 'tap', updated_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    await storage.syncPreferences()

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.boardTheme).toBe('wood')
    expect(prefs.appMode).toBe('light')
    expect(prefs.inputMode).toBe('tap')
    expect(prefs.preferencesUpdatedAt).toBe('2026-02-02T00:00:00.000Z')
    expect(mockUpsertResult).not.toHaveBeenCalled() // pull branch only, no push
  })

  it('local synced, server row is NOT newer: no local change at all', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('sharpin', 3)
      req.onsuccess = () => resolve(req.result)
    })
    await new Promise((resolve, reject) => {
      const t = db.transaction(['preferences'], 'readwrite')
      t.objectStore('preferences').put(
        { appMode: 'dark', boardTheme: 'classic', inputMode: 'drag', lastPulledAt: null, synced: true, preferencesUpdatedAt: '2026-03-03T00:00:00.000Z' },
        'acct-1',
      )
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    })
    db.close()

    mockSelectResult.mockResolvedValue({
      data: { app_mode: 'light', board_theme: 'wood', input_mode: 'tap', updated_at: '2026-01-01T00:00:00.000Z' }, // older
      error: null,
    })

    await storage.syncPreferences()

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.boardTheme).toBe('classic') // untouched
    expect(prefs.preferencesUpdatedAt).toBe('2026-03-03T00:00:00.000Z') // untouched
  })

  it('local synced, no server row at all (account never pushed a preference): safe no-op, not an error', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    mockSelectResult.mockResolvedValue({ data: null, error: null })

    await expect(storage.syncPreferences()).resolves.toBeUndefined()
    expect((await storage.getPreferences({ identity: 'acct-1' })).boardTheme).toBe('tournament') // default, untouched
  })

  it('local UNSYNCED: pushes (retries), never calls the pull/select path at all', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    await storage.updatePreferences({ boardTheme: 'wood' }) // leaves synced:false, fire-and-forget push already dispatched once
    mockUpsertResult.mockClear() // clear the updatePreferences-triggered call so we isolate syncPreferences' own retry
    mockUpsertResult.mockResolvedValue({ data: { updated_at: '2026-04-04T00:00:00.000Z' }, error: null })

    await storage.syncPreferences()

    expect(mockSelectResult).not.toHaveBeenCalled() // pull branch never entered
    expect(mockUpsertResult).toHaveBeenCalledTimes(1) // syncPreferences' own retry push
    expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(true)
  })

  it('compares against preferencesUpdatedAt specifically, NOT lastPulledAt -- a misleading lastPulledAt value must not affect the pull decision', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('sharpin', 3)
      req.onsuccess = () => resolve(req.result)
    })
    await new Promise((resolve, reject) => {
      const t = db.transaction(['preferences'], 'readwrite')
      t.objectStore('preferences').put(
        {
          appMode: 'dark', boardTheme: 'classic', inputMode: 'drag',
          // lastPulledAt deliberately set to a FAR-FUTURE value -- if the
          // sync logic ever accidentally compared against this instead of
          // preferencesUpdatedAt, it would wrongly treat the server's real,
          // newer row as stale and skip applying it.
          lastPulledAt: '2099-01-01T00:00:00.000Z',
          synced: true,
          preferencesUpdatedAt: '2026-01-01T00:00:00.000Z', // the actual, correct comparison basis
        },
        'acct-1',
      )
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    })
    db.close()

    mockSelectResult.mockResolvedValue({
      data: { app_mode: 'light', board_theme: 'wood', input_mode: 'tap', updated_at: '2026-02-02T00:00:00.000Z' },
      error: null,
    })

    await storage.syncPreferences()

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.boardTheme).toBe('wood') // applied -- proves the comparison used preferencesUpdatedAt, not lastPulledAt
    expect(prefs.lastPulledAt).toBe('2099-01-01T00:00:00.000Z') // untouched -- attempts' own field, syncPreferences never writes it
  })

  it('makes zero Supabase calls when the flag is off or there is no session', async () => {
    mockGetSession.mockResolvedValue(sessionOf(null))
    await storage.syncPreferences()
    expect(mockUpsertResult).not.toHaveBeenCalled()
    expect(mockSelectResult).not.toHaveBeenCalled()
  })
})

describe('the addendum scenario: a local edit in flight, a foreground pull fires concurrently', () => {
  it('never clobbers the pending edit -- the concurrent syncPreferences call correctly takes the push branch, not pull', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    // Every upsert call in this test hangs forever -- models "push(es)
    // still genuinely in flight" for the whole duration of the assertions
    // below, which is exactly the window being tested. This means
    // syncPreferences' OWN retry-push call (see below) will also hang --
    // deliberately not awaited to completion for that reason; only its
    // BRANCH DECISION (does it call the pull/select path at all) is what
    // this test is verifying.
    mockUpsertResult.mockReturnValue(new Promise(() => {}))

    await storage.updatePreferences({ boardTheme: 'wood' }) // synced:false locally; its own fire-and-forget push now pending

    // A foreground/resume trigger fires syncPreferences WHILE that push is
    // still in flight -- this must read the still-false synced flag fresh
    // and take the push branch, never the pull branch (which would apply a
    // stale server row over the pending local edit). Fired, not awaited --
    // its own retry push would hang on the same mock.
    storage.syncPreferences()

    // Let syncPreferences run up to (but not past) its own awaited retry-
    // push call -- enough for it to have already read `synced` and
    // committed to a branch.
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockSelectResult).not.toHaveBeenCalled() // pull branch never entered while unsynced
    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.boardTheme).toBe('wood') // the pending local edit survives untouched
    expect(prefs.synced).toBe(false) // still correctly pending -- nothing marked it synced speculatively
  })
})
