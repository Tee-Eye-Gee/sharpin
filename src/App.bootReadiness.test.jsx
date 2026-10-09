// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { bandForRating, updateRating } from './utils/rating'

// Backlog #1d, original scope: the boot races traced in
// docs/specs/usepuzzleengine-rating-corruption-investigation.md §1b, run
// against the REAL App + usePuzzleEngine + storage.js on fake-indexeddb,
// with the flag OFF -- the production configuration the investigation
// traced (identity resolves to GUEST_IDENTITY with zero awaits, then
// adoptLegacyDataIfSafe). Only leaf UI with no bearing on the race is
// stubbed (the react-chessboard board, Analyze mode's Stockfish panel).
//
// Seed: a pre-partitioning legacy profile at rating 1800. The default band
// (1200-1399) and the legacy band (1800-1999) don't overlap, so which
// profile picked the first puzzle is unambiguous.
//   Race A: the first puzzle must come from 1800-1999, not 1200-1399.
//   Race B: a commit fired at the earliest moment the app permits (Hint as
//           soon as the board is solvable) must compute its delta from 1800.

vi.mock('./lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    from: () => { throw new Error('flag off: no Supabase table access expected') },
  },
}))
vi.mock('./components/Board', () => ({
  default: ({ fen, status }) => <div data-testid="board" data-fen={fen ?? ''} data-status={status} />,
}))
vi.mock('./components/AnalyzePanel', () => ({ default: () => null }))

vi.stubEnv('VITE_ENABLE_ACCOUNT_SYNC', 'false')
vi.resetModules()
const { default: App } = await import('./App.jsx')

const STORES = ['profile', 'attempts', 'themeStats', 'preferences']
const LEGACY_RATING = 1800

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

async function withStores(mode, fn) {
  const db = await openRawDb()
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORES, mode)
      const out = fn(t)
      t.oncomplete = () => resolve(out)
      t.onerror = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}

async function readAll(store) {
  const db = await openRawDb()
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readonly').objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function readKey(store, key) {
  const db = await openRawDb()
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

function displayedRating() {
  return screen.getByText('Rating').parentElement.querySelector('.text-2xl').textContent
}

function displayedPuzzleRating() {
  return Number(screen.getByText('This puzzle').parentElement.querySelector('.font-mono').textContent)
}

function inBand(puzzleRating, rating) {
  const band = bandForRating(rating)
  return puzzleRating >= band.min && puzzleRating <= band.max
}

beforeEach(async () => {
  await withStores('readwrite', (t) => { for (const s of STORES) t.objectStore(s).clear() })
  // Same pre-partition shape storage.adoption.test.js seeds: bare 'main'
  // keys, attempts with no ownerId.
  await withStores('readwrite', (t) => {
    t.objectStore('profile').put(
      { rating: LEGACY_RATING, totalSolved: 12, totalFailed: 3, currentStreak: 4, bestStreak: 6 },
      'main',
    )
    t.objectStore('attempts').add({
      puzzleId: 'legacy0', themes: ['fork'], solved: true, hintUsed: false,
      ratingDelta: 10, timeTakenMs: 500, at: Date.now(),
    })
  })
})

afterEach(() => cleanup())

describe('Backlog #1d boot readiness (flag off, legacy local history)', () => {
  it('Race A: the first puzzle is chosen from the adopted rating band, not the default one', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('board').dataset.status).toBe('solving'), { timeout: 5000 })

    const puzzleRating = displayedPuzzleRating()
    console.log('[Race A] displayed rating:', displayedRating(), '| first puzzle rating:', puzzleRating)
    expect(displayedRating()).toBe(String(LEGACY_RATING))
    expect(inBand(puzzleRating, LEGACY_RATING)).toBe(true)
    expect(inBand(puzzleRating, 1200)).toBe(false)
  })

  it('Race B: a commit at the earliest possible moment computes its delta from the adopted rating', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('board').dataset.status).toBe('solving'), { timeout: 5000 })
    const puzzleRating = displayedPuzzleRating()

    // Hint's first press is the earliest commit the app's own code permits.
    fireEvent.click(screen.getByRole('button', { name: 'Hint' }))

    const expected = updateRating(LEGACY_RATING, puzzleRating, false)
    await waitFor(async () => {
      const owned = (await readAll('attempts')).filter((a) => a.ownerId === 'guest' && a.puzzleId !== 'legacy0')
      expect(owned).toHaveLength(1)
    })
    const committed = (await readAll('attempts')).find((a) => a.ownerId === 'guest' && a.puzzleId !== 'legacy0')
    const profile = await readKey('profile', 'guest')
    console.log('[Race B] puzzle', puzzleRating, '| ratingDelta', committed.ratingDelta, '| expected', expected.delta, '| guest profile rating', profile.rating)
    expect(committed.ratingDelta).toBe(expected.delta)
    expect(profile.rating).toBe(expected.newRating)
    expect(profile.rating).toBeGreaterThanOrEqual(1776)
    expect(profile.rating).toBeLessThanOrEqual(1824)
  })
})
