// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// Auth V2 step 2a, App level: the confirm-link boot (real src/lib/authUrl.js
// reading a real URL), the enterAccount funnel's first-sign-in check
// (decision Q3, real FirstSignInPrompt + real storage.js on fake-indexeddb),
// the display-name fix-up, and logout scope. Only the Supabase network
// boundary and identity-irrelevant leaf UI are stubbed. LaunchOverlay is
// stubbed to the same contract a successful sign-in uses: supabase-js
// already holds the new session, then onAuthenticated(session).

const NEW_ID = 'acct-new'
const EXISTING_ID = 'acct-existing'
const newAccountSession = { user: { id: NEW_ID, user_metadata: {} }, access_token: 'at-new', refresh_token: 'rt-new' }
const existingAccountSession = { user: { id: EXISTING_ID, user_metadata: {} }, access_token: 'at-ex', refresh_token: 'rt-ex' }

let currentSession = null
let signInSession = newAccountSession
let remoteAttemptCount = 0
let profileDisplayName = null
let fromCalls = []
let remoteInserts = []
let signOutCalls = []
let updateUserCalls = []
let invokeCalls = []
let verifyOtpImpl = null

const mockVerifyOtp = vi.fn((params) => verifyOtpImpl(params))

function builder(table) {
  fromCalls.push(table)
  const result = () => {
    if (table === 'puzzle_attempts') return Promise.resolve({ data: [], count: remoteAttemptCount, error: null })
    if (table === 'profile_stats') {
      return Promise.resolve({
        data: { rating: 1500, current_streak: 0, best_streak: 0, total_solved: 0, total_failed: 0 },
        error: null,
      })
    }
    if (table === 'theme_stats') return Promise.resolve({ data: [], error: null })
    if (table === 'profiles') return Promise.resolve({ data: { display_name: profileDisplayName }, error: null })
    return Promise.resolve({ data: null, error: null })
  }
  const b = {
    select: () => b,
    eq: () => b,
    gt: () => b,
    order: () => b,
    maybeSingle: () => result(),
    single: () => result(),
    insert: (rows) => { remoteInserts.push({ table, rows }); return Promise.resolve({ error: null }) },
    upsert: () => Promise.resolve({ error: null }),
    then: (res, rej) => result().then(res, rej),
  }
  return b
}

vi.mock('./lib/supabaseClient', () => ({
  supabase: {
    auth: {
      initialize: () => Promise.resolve({ error: null }),
      verifyOtp: (...a) => mockVerifyOtp(...a),
      getSession: () => Promise.resolve({ data: { session: currentSession } }),
      signOut: (options) => { signOutCalls.push(options); currentSession = null; return Promise.resolve({ error: null }) },
      updateUser: (attrs) => { updateUserCalls.push(attrs); return Promise.resolve({ data: { user: {} }, error: null }) },
    },
    functions: {
      invoke: (name, opts) => {
        invokeCalls.push({ name, body: opts?.body })
        return Promise.resolve({ data: { displayName: opts?.body?.displayName }, error: null })
      },
    },
    from: (table) => builder(table),
    rpc: () => Promise.resolve({ error: null }),
  },
}))
vi.mock('./components/Board', () => ({
  default: ({ status }) => <div data-testid="board" data-status={status} />,
}))
vi.mock('./components/AnalyzePanel', () => ({ default: () => null }))
vi.mock('./components/LaunchOverlay', () => ({
  default: ({ onGuest, onAuthenticated, linkError }) => (
    <div>
      {linkError && <p>{linkError}</p>}
      <button onClick={onGuest}>stub-guest</button>
      <button onClick={() => { currentSession = signInSession; onAuthenticated(signInSession) }}>stub-sign-in</button>
    </div>
  ),
}))

const STORES = ['profile', 'attempts', 'themeStats', 'preferences']

function openRawDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sharpin', 3)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      const d = req.result
      for (const name of STORES) {
        if (!d.objectStoreNames.contains(name)) {
          name === 'attempts'
            ? d.createObjectStore(name, { keyPath: 'id', autoIncrement: true })
            : d.createObjectStore(name)
        }
      }
    }
  })
}

async function withStores(fn) {
  const db = await openRawDb()
  try {
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORES, 'readwrite')
      fn(t)
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}

async function readAttempts() {
  const db = await openRawDb()
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(['attempts'], 'readonly').objectStore('attempts').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

// A guest's played attempt, in the shape storage.js's recordAttempt writes.
async function seedGuestAttempt(remoteId = 'r-guest-1') {
  await withStores((t) => {
    t.objectStore('attempts').put({
      ownerId: 'guest', puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
      ratingDelta: 10, timeTakenMs: 1000, at: Date.now(), synced: false, remoteId,
    })
  })
}

// authUrl.js reads the URL at module evaluation, so each test sets its URL
// and then imports a fresh module graph.
async function loadApp(path = '/') {
  window.history.replaceState(null, '', path)
  vi.resetModules()
  return (await import('./App.jsx')).default
}

function syncStarted() {
  return fromCalls.includes('profile_stats')
}

beforeEach(async () => {
  currentSession = null
  signInSession = newAccountSession
  remoteAttemptCount = 0
  profileDisplayName = null
  fromCalls = []
  remoteInserts = []
  signOutCalls = []
  updateUserCalls = []
  invokeCalls = []
  mockVerifyOtp.mockClear()
  verifyOtpImpl = () => {
    currentSession = newAccountSession
    return Promise.resolve({ data: { session: newAccountSession, user: newAccountSession.user }, error: null })
  }
  await withStores((t) => { for (const s of STORES) t.objectStore(s).clear() })
  await withStores((t) => {
    t.objectStore('profile').put({ rating: 1200, totalSolved: 1, totalFailed: 0, currentStreak: 1, bestStreak: 1 }, 'guest')
  })
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('Auth V2 boot: confirm link (?token_hash=&type=email)', () => {
  it('verifies once under StrictMode, strips the URL, and offers Merge/Discard BEFORE the account becomes active; Merge moves the guest rows', async () => {
    await seedGuestAttempt()
    const App = await loadApp('/?token_hash=th-confirm&type=email')
    render(<StrictMode><App /></StrictMode>)

    await waitFor(() => expect(screen.getByText('Merge')).toBeTruthy())
    console.log('[confirm] verifyOtp calls', mockVerifyOtp.mock.calls.length, '| url now', window.location.pathname + window.location.search,
      '| tables touched before answer', JSON.stringify(fromCalls))
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1)
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'th-confirm', type: 'email' })
    expect(window.location.search).toBe('')
    // Not yet 'valid': the #1d sync (which pulls profile_stats) hasn't started,
    // and nothing has been written or flagged.
    expect(syncStarted()).toBe(false)
    expect(remoteInserts).toHaveLength(0)
    expect(updateUserCalls).toHaveLength(0)
    expect(screen.getByTestId('board').dataset.status).toBe('loading')

    fireEvent.click(screen.getByText('Merge'))
    await waitFor(() => expect(screen.queryByText('Merge')).toBeNull())
    await waitFor(() => expect(syncStarted()).toBe(true))

    const attempts = await readAttempts()
    const localSummary = attempts.map((a) => ({ ownerId: a.ownerId, remoteId: a.remoteId, synced: a.synced }))
    const insertSummary = remoteInserts.map((i) => ({ table: i.table, ids: i.rows.map((r) => `${r.id}->${r.profile_id}`) }))
    console.log('[confirm] after Merge: local attempts', JSON.stringify(localSummary),
      '| remote inserts', JSON.stringify(insertSummary), '| updateUser', JSON.stringify(updateUserCalls))
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ ownerId: NEW_ID, remoteId: 'r-guest-1', synced: true })
    expect(attempts.filter((a) => a.ownerId === 'guest')).toHaveLength(0)
    expect(remoteInserts).toEqual([
      { table: 'puzzle_attempts', rows: [expect.objectContaining({ id: 'r-guest-1', profile_id: NEW_ID, puzzle_id: 'g1' })] },
    ])
    expect(updateUserCalls).toEqual([{ data: { guest_merge_resolved: true } }])
  })

  it('an expired link signs no one in and says why on the launch screen', async () => {
    verifyOtpImpl = () => Promise.resolve({ data: { session: null, user: null }, error: { status: 403, code: 'otp_expired' } })
    const App = await loadApp('/?token_hash=th-used&type=email')
    render(<App />)
    await waitFor(() => expect(screen.getByText('That link has expired or was already used. Request a new one.')).toBeTruthy())
    expect(currentSession).toBeNull()
    expect(window.location.search).toBe('')
  })
})

describe('Auth V2 first sign-in check (decision Q3)', () => {
  it('a sign-in on a device with NO guest data does not set guest_merge_resolved; a later sign-in on a device WITH guest data still gets the offer', async () => {
    const App = await loadApp('/')
    render(<App />)
    await waitFor(() => expect(screen.getByText('stub-sign-in')).toBeTruthy())

    // Device 1 (think: the phone's in-app browser) -- no guest history.
    fireEvent.click(screen.getByText('stub-sign-in'))
    await waitFor(() => expect(syncStarted()).toBe(true))
    expect(screen.queryByText('Merge')).toBeNull()
    console.log('[Q3] after no-guest sign-in: updateUser calls', JSON.stringify(updateUserCalls))
    expect(updateUserCalls).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }))
    await waitFor(() => expect(screen.getByText('stub-sign-in')).toBeTruthy())
    expect(signOutCalls).toEqual([{ scope: 'local' }])

    // Device 2 -- has guest history; same account, metadata still unflagged,
    // remote still empty.
    await seedGuestAttempt()
    fromCalls = []
    fireEvent.click(screen.getByText('stub-sign-in'))
    await waitFor(() => expect(screen.getByText('Merge')).toBeTruthy())
    console.log('[Q3] second sign-in with guest data: offer shown; sync started?', syncStarted())
    expect(syncStarted()).toBe(false)
  })

  it('an existing account (remote attempts) signing in with guest history: no prompt, guest rows untouched', async () => {
    signInSession = existingAccountSession
    remoteAttemptCount = 3
    await seedGuestAttempt()
    const App = await loadApp('/')
    render(<App />)
    await waitFor(() => expect(screen.getByText('stub-sign-in')).toBeTruthy())

    fireEvent.click(screen.getByText('stub-sign-in'))
    await waitFor(() => expect(syncStarted()).toBe(true))
    expect(screen.queryByText('Merge')).toBeNull()

    const attempts = await readAttempts()
    console.log('[existing] local attempts', JSON.stringify(attempts.map((a) => ({ ownerId: a.ownerId, synced: a.synced }))), '| remote inserts', remoteInserts.length)
    expect(attempts).toEqual([expect.objectContaining({ ownerId: 'guest', remoteId: 'r-guest-1', synced: false })])
    expect(remoteInserts).toHaveLength(0)
    expect(updateUserCalls).toHaveLength(0)
  })

  it('a flagged account (guest_merge_resolved) is never offered again', async () => {
    signInSession = { ...newAccountSession, user: { id: NEW_ID, user_metadata: { guest_merge_resolved: true } } }
    await seedGuestAttempt()
    const App = await loadApp('/')
    render(<App />)
    await waitFor(() => expect(screen.getByText('stub-sign-in')).toBeTruthy())
    fireEvent.click(screen.getByText('stub-sign-in'))
    await waitFor(() => expect(syncStarted()).toBe(true))
    expect(screen.queryByText('Merge')).toBeNull()
  })
})

describe('Auth V2 first sign-in: display name from sign-up metadata', () => {
  it('copies user_metadata.display_name into profiles via update-profile, then clears the metadata copy', async () => {
    signInSession = { ...newAccountSession, user: { id: NEW_ID, user_metadata: { display_name: 'ChessFan42' } } }
    const App = await loadApp('/')
    render(<App />)
    await waitFor(() => expect(screen.getByText('stub-sign-in')).toBeTruthy())
    fireEvent.click(screen.getByText('stub-sign-in'))

    await waitFor(() => expect(updateUserCalls).toEqual([{ data: { display_name: null } }]))
    console.log('[display name] invoke', JSON.stringify(invokeCalls), '| updateUser', JSON.stringify(updateUserCalls))
    expect(invokeCalls).toEqual([{ name: 'update-profile', body: { displayName: 'ChessFan42' } }])
  })

  it('leaves an existing profile name alone', async () => {
    profileDisplayName = 'AlreadySet'
    signInSession = { ...newAccountSession, user: { id: NEW_ID, user_metadata: { display_name: 'ChessFan42' } } }
    const App = await loadApp('/')
    render(<App />)
    await waitFor(() => expect(screen.getByText('stub-sign-in')).toBeTruthy())
    fireEvent.click(screen.getByText('stub-sign-in'))
    await waitFor(() => expect(fromCalls).toContain('profiles'))
    await new Promise((r) => setTimeout(r, 50))
    expect(invokeCalls).toHaveLength(0)
    expect(updateUserCalls).toHaveLength(0)
  })
})
