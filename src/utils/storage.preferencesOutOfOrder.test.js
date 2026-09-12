import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Commit 3's own scope: the out-of-order-response guard (`pendingToken`) on
// pushPreferencesIfPossible, against real (fake-indexeddb) IndexedDB, mocking
// only the Supabase network boundary. Traced in
// docs/specs/theme-preferences-sync-investigation.md's addendum, "one
// adjacent, narrower risk" section -- two fire-and-forget pushes racing each
// other, and (per this build's own scope) the same race across BOTH call
// paths that can invoke pushPreferencesIfPossible: updatePreferences' own
// click-triggered push, and syncPreferences' push-branch retry of that same
// still-unsynced edit.

const mockGetSession = vi.fn()
const mockUpsertResult = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a) },
    from: (table) => {
      if (table !== 'preferences') throw new Error(`unexpected supabase.from('${table}') in this test`)
      return {
        upsert: (row) => ({ select: () => ({ single: () => mockUpsertResult(row) }) }),
        select: () => { throw new Error('pull branch must never be entered in these tests') },
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

describe('out-of-order-response guard: two edits racing each other', () => {
  it('a stale response for a superseded edit does not flip synced:true while the newer edit is still genuinely pending', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))

    let resolveOlder
    mockUpsertResult
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve })) // push A (older edit)
      .mockReturnValueOnce(new Promise(() => {})) // push B (newer edit) hangs -- genuinely still in flight

    await storage.updatePreferences({ boardTheme: 'wood' })    // push A dispatched, pendingToken A
    await storage.updatePreferences({ boardTheme: 'classic' }) // push B dispatched, pendingToken B supersedes A's record

    // A's response finally arrives -- stale, since B has since superseded it.
    resolveOlder({ data: { updated_at: '2026-01-01T00:00:00.000Z' }, error: null })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    // The critical assertion: B's own push is still unresolved (hanging), so
    // the record must NOT be marked synced just because A's (stale) response
    // came back successful -- that would falsely claim the current, actually
    // different local state is confirmed on the server.
    expect(prefs.synced).toBe(false)
    expect(prefs.boardTheme).toBe('classic')
    expect(prefs.preferencesUpdatedAt).not.toBe('2026-01-01T00:00:00.000Z')
  })

  it('once the newer edit\'s own push confirms, a late-arriving stale response from the older push is a pure no-op', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))

    let resolveOlder, resolveNewer
    mockUpsertResult
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve }))

    await storage.updatePreferences({ boardTheme: 'wood' })    // push A, pendingToken A
    await storage.updatePreferences({ boardTheme: 'classic' }) // push B, pendingToken B

    // B (the newer edit's own push) resolves first.
    resolveNewer({ data: { updated_at: '2026-05-05T00:00:00.000Z' }, error: null })
    await vi.waitFor(async () => {
      expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(true)
    })

    // A's stale response arrives after -- must be discarded outright, not
    // reapply/clobber the confirmed newer state with its own (older) data.
    resolveOlder({ data: { updated_at: '2026-01-01T00:00:00.000Z' }, error: null })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.synced).toBe(true)
    expect(prefs.boardTheme).toBe('classic')
    expect(prefs.preferencesUpdatedAt).toBe('2026-05-05T00:00:00.000Z') // untouched by stale A
    expect(prefs.pendingToken).toBe(null)
  })
})

describe('out-of-order-response guard holds across BOTH call paths for the SAME pending edit', () => {
  it('a click-triggered push and a concurrent foreground-triggered retry for the same edit do not treat each other\'s response as stale', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))

    let resolveClickPush, resolveRetryPush
    mockUpsertResult
      .mockImplementationOnce(() => new Promise((resolve) => { resolveClickPush = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetryPush = resolve }))

    await storage.updatePreferences({ boardTheme: 'wood' }) // click-triggered push in flight, pendingToken T

    // A foreground/resume trigger fires syncPreferences while that push is
    // still unresolved -- it reads synced:false and retries the SAME edit,
    // passing the SAME pendingToken T through (not a fresh one), exactly
    // like syncPreferences' own push-branch is written to do.
    storage.syncPreferences()
    await new Promise((resolve) => setTimeout(resolve, 10)) // let it read synced:false and dispatch its own retry push

    expect(mockUpsertResult).toHaveBeenCalledTimes(2) // both pushes for the same edit genuinely in flight at once

    // The retry push's response resolves first.
    resolveRetryPush({ data: { updated_at: '2026-06-06T00:00:00.000Z' }, error: null })
    await vi.waitFor(async () => {
      expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(true)
    })

    // The original click-triggered push's response arrives after -- same
    // token, so this must be treated as a harmless redundant confirmation,
    // never as a stale response from a superseded edit.
    resolveClickPush({ data: { updated_at: '2026-06-06T00:00:00.000Z' }, error: null })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.synced).toBe(true)
    expect(prefs.boardTheme).toBe('wood')
    expect(prefs.pendingToken).toBe(null)
  })

  it('a NEW edit made while both paths\' pushes for the prior edit are still in flight correctly supersedes both', async () => {
    mockGetSession.mockResolvedValue(sessionOf('acct-1'))

    let resolveClickPush, resolveRetryPush, resolveNewEditPush
    mockUpsertResult
      .mockImplementationOnce(() => new Promise((resolve) => { resolveClickPush = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetryPush = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewEditPush = resolve }))

    await storage.updatePreferences({ boardTheme: 'wood' }) // click push, pendingToken T1
    storage.syncPreferences() // foreground retry of T1, same token
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mockUpsertResult).toHaveBeenCalledTimes(2)

    // Before either T1 response arrives, the user makes a genuinely new edit.
    await storage.updatePreferences({ boardTheme: 'classic' }) // pendingToken T2, supersedes T1 entirely
    expect(mockUpsertResult).toHaveBeenCalledTimes(3)

    // Both stale T1 responses now arrive (in either order) -- neither may
    // mark the record synced, since T2's own push hasn't confirmed yet.
    resolveClickPush({ data: { updated_at: '2026-01-01T00:00:00.000Z' }, error: null })
    resolveRetryPush({ data: { updated_at: '2026-01-01T00:00:00.000Z' }, error: null })
    await new Promise((resolve) => setTimeout(resolve, 20))

    let prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.synced).toBe(false)
    expect(prefs.boardTheme).toBe('classic')

    // T2's own push finally confirms.
    resolveNewEditPush({ data: { updated_at: '2026-07-07T00:00:00.000Z' }, error: null })
    await vi.waitFor(async () => {
      expect((await storage.getPreferences({ identity: 'acct-1' })).synced).toBe(true)
    })

    prefs = await storage.getPreferences({ identity: 'acct-1' })
    expect(prefs.boardTheme).toBe('classic')
    expect(prefs.preferencesUpdatedAt).toBe('2026-07-07T00:00:00.000Z')
    expect(prefs.pendingToken).toBe(null)
  })
})
