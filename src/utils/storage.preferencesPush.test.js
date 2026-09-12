import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Commit 1's own scope: updatePreferences/pushPreferencesIfPossible, against
// real (fake-indexeddb) IndexedDB, mocking only the Supabase network
// boundary. Pull-side branch logic is Commit 2's own test file.

const mockGetSession = vi.fn()
const mockUpsertResult = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a) },
    from: (table) => {
      if (table !== 'preferences') throw new Error(`unexpected supabase.from('${table}') in this test`)
      return {
        upsert: (row) => ({
          select: () => ({
            single: () => mockUpsertResult(row),
          }),
        }),
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
  await clearAllStores()
})

describe('updatePreferences / pushPreferencesIfPossible', () => {
  it('writes locally with synced:false immediately, then flips to synced:true only after a confirmed success response', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    mockUpsertResult.mockResolvedValue({ data: { updated_at: '2026-01-01T00:00:00.000Z' }, error: null })

    const prefs = await storage.updatePreferences({ boardTheme: 'wood' })
    // The local write itself is synchronous-awaited and already synced:false
    // by the time updatePreferences returns -- the push is fire-and-forget.
    expect(prefs.synced).toBe(false)
    expect((await storage.getPreferences({ identity: 'acct-1' })).boardTheme).toBe('wood')
    expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(false)

    // Let the fire-and-forget push's microtasks resolve.
    await vi.waitFor(async () => {
      expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(true)
    })

    const finalPrefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(finalPrefs.boardTheme).toBe('wood')
    expect(finalPrefs.preferencesUpdatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(mockUpsertResult).toHaveBeenCalledWith(
      expect.objectContaining({ profile_id: 'acct-1', board_theme: 'wood' }),
    )
  })

  it('leaves synced:false on a failed push, never flips it speculatively', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    mockUpsertResult.mockResolvedValue({ data: null, error: { message: 'network error' } })

    await storage.updatePreferences({ boardTheme: 'classic' })

    // Give the fire-and-forget push a chance to run to completion.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.synced).toBe(false)
    expect(prefs.boardTheme).toBe('classic') // local write still applied regardless of push outcome
  })

  it('never flips synced to true on request-send alone -- only after the mocked response actually resolves', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    let resolveUpsert
    mockUpsertResult.mockReturnValue(new Promise((resolve) => { resolveUpsert = resolve }))

    await storage.updatePreferences({ inputMode: 'tap' })

    // Push is in flight (the mock promise hasn't resolved yet) -- must still read false.
    expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(false)

    resolveUpsert({ data: { updated_at: '2026-02-02T00:00:00.000Z' }, error: null })
    await vi.waitFor(async () => {
      expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(true)
    })
  })

  it('makes zero Supabase calls for a guest (no session) -- local write applies, push no-ops', async () => {
    mockGetSession.mockResolvedValue(sessionOf(null))

    await storage.updatePreferences({ boardTheme: 'wood' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockUpsertResult).not.toHaveBeenCalled()
    const prefs = await storage.getPreferences({ identity: storage.GUEST_IDENTITY })
    expect(prefs.boardTheme).toBe('wood')
    // Guest rows are never meant to sync -- synced stays false forever, same as
    // attempts' own "guest rows stay synced:false forever, by design" convention,
    // it just never matters since nothing ever retries a push with no session.
  })

  it('pullRemoteAttempts\' own watermark write does not go through updatePreferences and never pushes', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    // No puzzle_attempts mock needed -- pullRemoteAttempts no-ops cleanly if
    // ACCOUNT_SYNC_ENABLED reads false in this env; instead, directly exercise
    // the exact call shape pullRemoteAttempts uses (savePreferences, not
    // updatePreferences) to confirm it never triggers a push.
    const prefs = await storage.getPreferences()
    await storage.savePreferences({ ...prefs, lastPulledAt: '2026-03-03T00:00:00.000Z' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockUpsertResult).not.toHaveBeenCalled()
    expect((await storage.getPreferences()).lastPulledAt).toBe('2026-03-03T00:00:00.000Z')
  })

  it('each call pushes independently -- no debounce/batching of rapid successive changes', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))
    mockUpsertResult.mockResolvedValue({ data: { updated_at: '2026-04-04T00:00:00.000Z' }, error: null })

    await storage.updatePreferences({ boardTheme: 'wood' })
    await storage.updatePreferences({ boardTheme: 'classic' })
    await storage.updatePreferences({ boardTheme: 'tournament' })

    await vi.waitFor(() => {
      expect(mockUpsertResult).toHaveBeenCalledTimes(3)
    })
  })
})
