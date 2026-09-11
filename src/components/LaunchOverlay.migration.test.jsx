// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// Commit 2's own scope: proves the actual bug this commit fixes -- with
// pre-existing guest history, does the Merge/Discard prompt still appear
// after Create Account, and does Merge/Discard actually move/clear the
// right identity's data -- by rendering the real LaunchOverlay component
// (real DOM via jsdom, real IndexedDB via fake-indexeddb underneath the
// real, unmocked storage.js) and driving it exactly as a user would,
// mocking only the Supabase network boundary. SequenceBoardInput (drag-based
// board UI, unrelated to this commit) is stubbed to a plain button so the
// test drives handleCreateAccount/handleMerge/handleDiscard directly rather
// than simulating chess-piece drags.

vi.mock('./SequenceBoardInput', () => ({
  default: ({ onSequenceComplete, disabled }) => (
    <button disabled={disabled} onClick={() => onSequenceComplete('fake-hash')}>
      complete-sequence
    </button>
  ),
}))

// Mirrors the real GoTrueClient invariant this whole investigation chain is
// built on: calling setSession() changes what a SUBSEQUENT getSession() call
// returns. A mock that didn't model this link would let a wrongly-ordered
// fix pass by accident -- this is deliberately the same shape as the actual
// bug (ordering-dependent identity resolution), not a shortcut around it.
let currentSession = null
const mockGetSession = vi.fn(() => Promise.resolve({ data: { session: currentSession } }))
const mockSetSession = vi.fn((session) => {
  currentSession = { ...session, user: { id: 'acct-1' } }
  return Promise.resolve({ data: { session: currentSession }, error: null })
})
const mockFunctionsInvoke = vi.fn()
const mockRpc = vi.fn(() => Promise.resolve({ error: null }))

function fromMock(table) {
  if (table === 'puzzle_attempts') {
    return {
      select: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }),
      insert: () => Promise.resolve({ error: null }),
    }
  }
  if (table === 'preferences') {
    return { upsert: () => Promise.resolve({ error: null }) }
  }
  throw new Error(`unexpected supabase.from('${table}') in this test`)
}

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a), setSession: (...a) => mockSetSession(...a) },
    functions: { invoke: (...a) => mockFunctionsInvoke(...a) },
    rpc: (...a) => mockRpc(...a),
    from: (table) => fromMock(table),
  },
}))

const storage = await import('../utils/storage')

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
  mockGetSession.mockClear()
  mockSetSession.mockClear()
  mockFunctionsInvoke.mockReset()
  mockRpc.mockClear()
  await clearAllStores()
})

afterEach(() => cleanup())

async function seedGuestAttempt() {
  // Real guest write through the real storage.js -- currentSession is null
  // at this point, so this lands under GUEST_IDENTITY exactly as an actual
  // guest's play would.
  await storage.recordAttempt({
    puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
    newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
  })
}

describe('LaunchOverlay Create Account -> Merge/Discard, with real storage.js + fake-indexeddb underneath', () => {
  it('shows the Merge/Discard prompt for pre-existing guest history -- the exact case that was silently skipped before this commit\'s fix', async () => {
    await seedGuestAttempt()
    mockFunctionsInvoke.mockResolvedValue({ data: { session: { access_token: 'at', refresh_token: 'rt' } }, error: null })

    const LaunchOverlay = (await import('./LaunchOverlay')).default
    const onAuthenticated = vi.fn()
    render(<LaunchOverlay onGuest={() => {}} onAuthenticated={onAuthenticated} actionsDisabled={false} boardTheme="tournament" />)

    fireEvent.click(screen.getByText('Create Account'))
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(screen.getByText('Account created.')).toBeTruthy())
    // The bug this commit fixes would have skipped straight to
    // onAuthenticated instead of ever showing this prompt.
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it('Merge moves the guest attempt into the new account\'s namespace and clears it from GUEST_IDENTITY', async () => {
    await seedGuestAttempt()
    mockFunctionsInvoke.mockResolvedValue({ data: { session: { access_token: 'at', refresh_token: 'rt' } }, error: null })

    const LaunchOverlay = (await import('./LaunchOverlay')).default
    const onAuthenticated = vi.fn()
    render(<LaunchOverlay onGuest={() => {}} onAuthenticated={onAuthenticated} actionsDisabled={false} boardTheme="tournament" />)

    fireEvent.click(screen.getByText('Create Account'))
    fireEvent.click(screen.getByText('complete-sequence'))
    await waitFor(() => expect(screen.getByText('Merge')).toBeTruthy())

    fireEvent.click(screen.getByText('Merge'))
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))

    // currentSession is now the account (set by mockSetSession above) --
    // reading storage.js directly, unmocked, confirms real IndexedDB state.
    const accountAttempts = await storage.getAllAttempts()
    expect(accountAttempts).toHaveLength(1)
    expect(accountAttempts[0].puzzleId).toBe('g1')

    const guestAttempts = await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })
    expect(guestAttempts).toHaveLength(0)
  })

  it('Discard clears only GUEST_IDENTITY, never touching the new account\'s (already-empty) namespace', async () => {
    await seedGuestAttempt()
    mockFunctionsInvoke.mockResolvedValue({ data: { session: { access_token: 'at', refresh_token: 'rt' } }, error: null })

    const LaunchOverlay = (await import('./LaunchOverlay')).default
    const onAuthenticated = vi.fn()
    render(<LaunchOverlay onGuest={() => {}} onAuthenticated={onAuthenticated} actionsDisabled={false} boardTheme="tournament" />)

    fireEvent.click(screen.getByText('Create Account'))
    fireEvent.click(screen.getByText('complete-sequence'))
    await waitFor(() => expect(screen.getByText('Discard')).toBeTruthy())

    fireEvent.click(screen.getByText('Discard'))
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))

    expect(await storage.getAllAttempts({ identity: storage.GUEST_IDENTITY })).toHaveLength(0)
    expect(await storage.getAllAttempts()).toHaveLength(0) // account namespace, also empty -- never had anything
  })

  it('skips straight to onAuthenticated with no guest history at all (unaffected control case)', async () => {
    mockFunctionsInvoke.mockResolvedValue({ data: { session: { access_token: 'at', refresh_token: 'rt' } }, error: null })

    const LaunchOverlay = (await import('./LaunchOverlay')).default
    const onAuthenticated = vi.fn()
    render(<LaunchOverlay onGuest={() => {}} onAuthenticated={onAuthenticated} actionsDisabled={false} boardTheme="tournament" />)

    fireEvent.click(screen.getByText('Create Account'))
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Account created.')).toBeNull()
  })
})
