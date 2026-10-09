// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { bandForRating, updateRating } from './utils/rating'

// Backlog #1d, user-change expansion: when the active user changes (login,
// logout, a session restored on page load such as a recovery link's), the
// outgoing user's puzzle is discarded, and the incoming user's puzzle and
// rating math come from their own profile only once it's ready -- for an
// account, after pullProfileStats has landed. Real App + usePuzzleEngine +
// storage.js on fake-indexeddb; only the Supabase network boundary and leaf
// UI with no bearing on identity (board, launch-overlay internals, Analyze
// panel) are stubbed.
//
// Ratings: guest 1800 (band 1800-1999), account 2400 (band 2400-2599),
// default 1200 (band 1200-1399) -- three disjoint bands, so every
// assertion about "whose band" is unambiguous.

const GUEST_RATING = 1800
const ACCOUNT_RATING = 2400
const ACCOUNT_ID = 'acct-2400'
const accountSession = { user: { id: ACCOUNT_ID }, access_token: 'at', refresh_token: 'rt' }

let currentSession = null
let profileStatsResult = null // () => Promise<{ data, error }>
let remoteInserts = []

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function builder(table) {
  const result = () => {
    if (table === 'profile_stats') return profileStatsResult()
    if (table === 'theme_stats' || table === 'puzzle_attempts') return Promise.resolve({ data: [], error: null })
    if (table === 'profiles') return Promise.resolve({ data: { display_name: null }, error: null })
    return Promise.resolve({ data: null, error: null })
  }
  const b = {
    select: () => b,
    eq: () => b,
    gt: () => b,
    maybeSingle: () => result(),
    single: () => result(),
    insert: (row) => { remoteInserts.push({ table, row }); return Promise.resolve({ error: null }) },
    upsert: () => Promise.resolve({ error: null }),
    then: (res, rej) => result().then(res, rej),
  }
  return b
}

vi.mock('./lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: currentSession } }),
      signOut: () => { currentSession = null; return Promise.resolve({ error: null }) },
    },
    from: (table) => builder(table),
    rpc: () => Promise.resolve({ error: null }),
  },
}))
vi.mock('./components/Board', () => ({
  default: ({ fen, status }) => <div data-testid="board" data-fen={fen ?? ''} data-status={status} />,
}))
vi.mock('./components/AnalyzePanel', () => ({ default: () => null }))
// The real overlay's sequence board is irrelevant here; this stub reaches
// the same onAuthenticated(session) contract a successful Login uses, with
// the live session already switched first (as setSession() does).
vi.mock('./components/LaunchOverlay', () => ({
  default: ({ onGuest, onAuthenticated }) => (
    <div>
      <button onClick={onGuest}>stub-guest</button>
      <button onClick={() => { currentSession = accountSession; onAuthenticated(accountSession) }}>stub-login</button>
    </div>
  ),
}))

const { default: App } = await import('./App.jsx')

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

async function read(store, key) {
  const db = await openRawDb()
  try {
    return await new Promise((resolve, reject) => {
      const s = db.transaction([store], 'readonly').objectStore(store)
      const req = key === undefined ? s.getAll() : s.get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

function boardStatus() {
  return screen.getByTestId('board').dataset.status
}

function displayedRating() {
  return screen.getByText('Rating').parentElement.querySelector('.text-2xl').textContent
}

function displayedPuzzleRating() {
  const el = screen.getByText('This puzzle').parentElement.querySelector('.font-mono')
  return el ? Number(el.textContent) : null
}

function inBand(puzzleRating, rating) {
  const band = bandForRating(rating)
  return puzzleRating >= band.min && puzzleRating <= band.max
}

async function waitForPuzzleFrom(rating) {
  await waitFor(() => {
    expect(boardStatus()).toBe('solving')
    expect(displayedRating()).toBe(String(rating))
    expect(inBand(displayedPuzzleRating(), rating)).toBe(true)
  }, { timeout: 5000 })
}

const accountStatsRow = {
  data: { rating: ACCOUNT_RATING, current_streak: 0, best_streak: 3, total_solved: 9, total_failed: 4 },
  error: null,
}

beforeEach(async () => {
  currentSession = null
  remoteInserts = []
  profileStatsResult = () => Promise.resolve(accountStatsRow)
  await withStores((t) => { for (const s of STORES) t.objectStore(s).clear() })
  await withStores((t) => {
    t.objectStore('profile').put(
      { rating: GUEST_RATING, totalSolved: 20, totalFailed: 5, currentStreak: 2, bestStreak: 7 },
      'guest',
    )
  })
})

afterEach(() => cleanup())

describe('Backlog #1d user change: login', () => {
  it('guest 1800 -> account 2400: display and band switch to the account, and the first committed delta uses 2400', async () => {
    render(<App />)
    await waitForPuzzleFrom(GUEST_RATING)
    const guestPuzzle = displayedPuzzleRating()
    console.log('[login] before: displayed', displayedRating(), '| puzzle', guestPuzzle)

    fireEvent.click(screen.getByText('stub-login'))
    await waitForPuzzleFrom(ACCOUNT_RATING)
    const accountPuzzle = displayedPuzzleRating()
    console.log('[login] after: displayed', displayedRating(), '| puzzle', accountPuzzle)

    fireEvent.click(screen.getByRole('button', { name: 'Hint' }))
    await waitFor(async () => {
      expect((await read('attempts')).filter((a) => a.ownerId === ACCOUNT_ID)).toHaveLength(1)
    })
    const [committed] = (await read('attempts')).filter((a) => a.ownerId === ACCOUNT_ID)
    const expected = updateRating(ACCOUNT_RATING, accountPuzzle, false)
    const accountProfile = await read('profile', ACCOUNT_ID)
    console.log('[login] committed delta', committed.ratingDelta, '| expected', expected.delta, '| account profile rating', accountProfile.rating)
    expect(committed.ratingDelta).toBe(expected.delta)
    expect(accountProfile.rating).toBe(expected.newRating)
    // The guest's discarded puzzle never committed, and the guest profile is untouched.
    expect((await read('attempts')).filter((a) => a.ownerId === 'guest')).toHaveLength(0)
    expect((await read('profile', 'guest')).rating).toBe(GUEST_RATING)
  })
})

describe('Backlog #1d user change: logout', () => {
  it('account -> guest: display and band return to the guest profile', async () => {
    render(<App />)
    await waitForPuzzleFrom(GUEST_RATING)
    fireEvent.click(screen.getByText('stub-login'))
    await waitForPuzzleFrom(ACCOUNT_RATING)

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }))

    await waitForPuzzleFrom(GUEST_RATING)
    console.log('[logout] after: displayed', displayedRating(), '| puzzle', displayedPuzzleRating())
    expect(currentSession).toBeNull()
  })
})

describe('Backlog #1d commit guard', () => {
  it('a commit fired as the user changes, while the account stats pull is pending, is blocked: nothing written anywhere', async () => {
    const pendingPull = deferred()
    profileStatsResult = () => pendingPull.promise
    render(<App />)
    await waitForPuzzleFrom(GUEST_RATING)

    // Both in one act(): the Hint handler runs against the guest puzzle
    // while the live session has already switched to the account and its
    // stats pull hasn't landed -- the exact window a wrong delta came from.
    await act(async () => {
      screen.getByText('stub-login').click()
      screen.getByRole('button', { name: 'Hint' }).click()
    })

    // Board waits: no puzzle chosen from a defaulted account profile.
    await waitFor(() => expect(boardStatus()).toBe('loading'))
    expect(displayedRating()).toBe('—')
    expect(screen.getByRole('button', { name: 'Hint' }).disabled).toBe(true)

    const attempts = await read('attempts')
    console.log('[guard] attempts after blocked commit:', JSON.stringify(attempts), '| remote inserts:', remoteInserts.length)
    expect(attempts).toHaveLength(0)
    expect(remoteInserts).toHaveLength(0)
    expect((await read('profile', 'guest')).rating).toBe(GUEST_RATING)
    expect(await read('profile', ACCOUNT_ID)).toBeUndefined()

    // Once the pull lands, the account's own puzzle loads normally.
    await act(async () => { pendingPull.resolve(accountStatsRow) })
    await waitForPuzzleFrom(ACCOUNT_RATING)
  })
})

describe('Backlog #1d user change: session restored on page load (recovery-link sign-in)', () => {
  it('no puzzle until the account stats pull lands, then the account band -- never a default-band puzzle', async () => {
    // A recovery (or any emailed) link opens a fresh page load: supabase-js
    // stores the session from the URL during client init, so App's boot
    // getSession() already returns it. That is the path this exercises.
    currentSession = accountSession
    const pendingPull = deferred()
    profileStatsResult = () => pendingPull.promise
    render(<App />)

    await waitFor(() => expect(screen.getByText('Rating')).toBeTruthy())
    // Give boot + sync every chance to (wrongly) load something.
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    console.log('[restore] while pull pending: status', boardStatus(), '| displayed', displayedRating())
    expect(boardStatus()).toBe('loading')
    expect(displayedPuzzleRating()).toBeNull()

    await act(async () => { pendingPull.resolve(accountStatsRow) })
    await waitForPuzzleFrom(ACCOUNT_RATING)
    console.log('[restore] after pull: displayed', displayedRating(), '| puzzle', displayedPuzzleRating())
  })
})
