// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// Rewritten for Auth V2 from LaunchOverlay.migration.test.jsx: the
// Merge/Discard prompt and migrateGuestDataToAccount moved verbatim into
// FirstSignInPrompt, which App.jsx shows on a NEW account's first sign-in
// (decision Q3) instead of right after V1's create-account call. The
// storage assertions carry over unchanged: real FirstSignInPrompt, real
// storage.js on fake-indexeddb, only the Supabase network boundary mocked.
//
// By the time the prompt is shown, supabase-js already holds the new
// account's session (a confirm link's verifyOtp, or signInWithPassword), so
// every test starts with currentSession set to the account -- which is
// exactly why the migration must name GUEST_IDENTITY explicitly rather
// than auto-resolve identity.

const ACCOUNT_ID = 'acct-1'
const accountSession = { user: { id: ACCOUNT_ID, user_metadata: {} }, access_token: 'at', refresh_token: 'rt' }

let currentSession = null
let remoteAttemptCount = 0
let remoteCountQueries = 0
const mockRpc = vi.fn(() => Promise.resolve({ error: null }))
const mockUpdateUser = vi.fn(() => Promise.resolve({ data: { user: {} }, error: null }))
const mockInsert = vi.fn(() => Promise.resolve({ error: null }))

function fromMock(table) {
  if (table === 'puzzle_attempts') {
    return {
      select: () => ({
        eq: () => {
          remoteCountQueries += 1
          return Promise.resolve({ count: remoteAttemptCount, error: null })
        },
      }),
      insert: (...a) => mockInsert(...a),
    }
  }
  if (table === 'preferences') {
    return { upsert: () => Promise.resolve({ error: null }) }
  }
  throw new Error(`unexpected supabase.from('${table}') in this test`)
}

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: currentSession } }),
      updateUser: (...a) => mockUpdateUser(...a),
    },
    rpc: (...a) => mockRpc(...a),
    from: (table) => fromMock(table),
  },
}))

const storage = await import('../utils/storage')
const { default: FirstSignInPrompt, shouldOfferGuestMerge } = await import('./FirstSignInPrompt')

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
  currentSession = null
  remoteAttemptCount = 0
  remoteCountQueries = 0
  mockRpc.mockClear()
  mockUpdateUser.mockClear()
  mockInsert.mockClear()
  await clearAllStores()
})

afterEach(() => cleanup())

async function seedGuestAttempt() {
  // Real guest write through the real storage.js -- currentSession is null
  // at this point, so this lands under GUEST_IDENTITY exactly as an actual
  // guest's play would. Only after this does the account session appear.
  await storage.recordAttempt({
    puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
    newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
  })
  currentSession = accountSession
}

function renderPrompt() {
  const onResolved = vi.fn()
  render(<FirstSignInPrompt session={accountSession} onResolved={onResolved} />)
  return onResolved
}

describe('FirstSignInPrompt (Auth V2 first sign-in) -> Merge/Discard, with real storage.js + fake-indexeddb underneath', () => {
  it('is offered for guest history + an empty remote + an unflagged account, and shows Merge/Discard', async () => {
    await seedGuestAttempt()
    expect(await shouldOfferGuestMerge(accountSession)).toBe(true)

    const onResolved = renderPrompt()
    expect(screen.getByText('Merge')).toBeTruthy()
    expect(screen.getByText('Discard')).toBeTruthy()
    // Showing the prompt resolves nothing and writes nothing.
    expect(onResolved).not.toHaveBeenCalled()
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('Merge moves the guest attempt into the new account\'s namespace, clears it from GUEST_IDENTITY, and sets guest_merge_resolved', async () => {
    await seedGuestAttempt()
    const onResolved = renderPrompt()

    fireEvent.click(screen.getByText('Merge'))
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))

    // currentSession is the account -- reading storage.js directly,
    // unmocked, confirms real IndexedDB state.
    const accountAttempts = await storage.getAllAttempts()
    expect(accountAttempts).toHaveLength(1)
    expect(accountAttempts[0].puzzleId).toBe('g1')

    const guestAttempts = await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })
    expect(guestAttempts).toHaveLength(0)

    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockInsert.mock.calls[0][0]).toEqual([expect.objectContaining({ profile_id: ACCOUNT_ID, puzzle_id: 'g1' })])
    expect(mockRpc).toHaveBeenCalledWith('recompute_stats')
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { guest_merge_resolved: true } })
  })

  it('does NOT write local profile/themeStats directly -- that gap (Backlog #1g) is closed by storage.js\'s pullProfileStats(), wired into App.jsx\'s runSyncSequence, not by migrateGuestDataToAccount', async () => {
    await seedGuestAttempt()
    const onResolved = renderPrompt()

    fireEvent.click(screen.getByText('Merge'))
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))

    // Confirmed, not merely absent: migrateGuestDataToAccount deliberately
    // does not write a local profile/themeStats record for the new identity
    // -- App.jsx's runSyncSequence does, via pullProfileStats(), once the
    // account becomes active (after onResolved). This test renders the
    // prompt in isolation, so that never fires here -- see
    // src/utils/storage.pullProfileStats.test.js for the fix itself.
    expect((await storage.getProfile()).totalSolved).toBe(0) // still DEFAULT_PROFILE here -- expected, not a regression
    expect(await storage.getThemeStats()).toEqual({})
  })

  it('Discard clears only GUEST_IDENTITY, never touching the new account\'s (already-empty) namespace, and sets guest_merge_resolved', async () => {
    await seedGuestAttempt()
    const onResolved = renderPrompt()

    fireEvent.click(screen.getByText('Discard'))
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))

    expect(await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })).toHaveLength(0)
    expect(await storage.getAllAttempts()).toHaveLength(0) // account namespace, also empty -- never had anything
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { guest_merge_resolved: true } })
  })

  it('is not offered with no guest history at all -- and nothing is flagged (unaffected control case, decision Q3)', async () => {
    currentSession = accountSession
    expect(await shouldOfferGuestMerge(accountSession)).toBe(false)
    // Decided locally: no remote query needed, and the account is NOT
    // marked resolved just because this device had nothing to offer.
    expect(remoteCountQueries).toBe(0)
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('is not offered when the account already has remote attempts, or is already flagged', async () => {
    await seedGuestAttempt()
    remoteAttemptCount = 2
    expect(await shouldOfferGuestMerge(accountSession)).toBe(false)

    remoteAttemptCount = 0
    const flagged = { ...accountSession, user: { ...accountSession.user, user_metadata: { guest_merge_resolved: true } } }
    expect(await shouldOfferGuestMerge(flagged)).toBe(false)
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })
})
