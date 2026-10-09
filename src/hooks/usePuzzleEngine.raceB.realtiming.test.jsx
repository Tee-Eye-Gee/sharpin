// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { useEffect } from 'react'

// Re-run of the deleted "Addendum ... Part 2" diagnostic, using ONLY tooling
// actually present in this repo's package.json (vitest, jsdom, fake-indexeddb,
// @testing-library/react) -- no Playwright/Puppeteer/CDP, no real browser, no
// CPU throttling. Confirmed before writing this file: `grep -n
// "playwright|puppeteer" package.json` returns nothing; jsdom/fake-indexeddb/
// testing-library/vitest are the only relevant devDependencies.
//
// GOAL: measure Race B (docs/specs/usepuzzleengine-rating-corruption-
// investigation.md §1b) -- the race between adoptLegacyDataIfSafe's write
// (started at App-boot, zero intervening awaits when VITE_ENABLE_ACCOUNT_SYNC
// is off) and commitAttempt's own later, independent getProfile() read
// (fired whenever the user's first real interaction happens) -- by rendering
// the REAL usePuzzleEngine hook (real chess.js, real puzzle JSON via
// import.meta.glob, real storage.js, real fake-indexeddb) inside a harness
// component that reproduces App.jsx's actual boot-effect body verbatim for
// the flag-off branch (App.jsx:147-156: identity = GUEST_IDENTITY
// synchronously, then `await adoptLegacyDataIfSafe(identity)`), preserving
// the same hook-call-before-boot-effect registration order App.jsx has
// (usePuzzleEngine() called first in the harness body, exactly like
// App.jsx:30-52 vs its boot effect at line 144).
//
// Interaction delay is real elapsed wall-clock time (`await new Promise(r =>
// setTimeout(r, ms))`), not vi.useFakeTimers() -- fake-indexeddb's own
// internal request scheduling runs on real timers/microtasks, and faking
// them would either stall fake-indexeddb or require manually pumping it in
// lockstep with assumptions about its internals this project has no
// visibility into. Real timers keep every measurement here an actual
// observed duration in this Node+jsdom+fake-indexeddb process, not a
// simulated one.
//
// Explicit, load-bearing caveat, stated up front rather than glossed over:
// fake-indexeddb (in-memory, pure JS, running in Node under vitest) has
// different absolute timing characteristics than a real browser's IndexedDB
// (backed by real disk I/O, a real browser process, real main-thread
// contention with rendering/layout). The relative ordering this test
// measures -- "adoption's 4-reads-then-a-write chain vs. a single later
// profile read, separated by a real elapsed delay" -- exercises the exact
// same code paths and the exact same relative shape of work the original
// investigation reasoned about, but the absolute millisecond numbers below
// are only representative of THIS environment, not a browser. That
// limitation is real and is reported as such, not hidden.

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    from: () => ({}),
  },
}))

vi.stubEnv('VITE_ENABLE_ACCOUNT_SYNC', 'false')
vi.resetModules()

const storage = await import('../utils/storage.js')
const { usePuzzleEngine } = await import('./usePuzzleEngine.js')

const STORES = ['profile', 'attempts', 'themeStats', 'preferences']

async function openRawDb() {
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

async function clearAllStores() {
  const db = await openRawDb()
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORES, 'readwrite')
    for (const name of STORES) t.objectStore(name).clear()
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

// Same pre-partition shape storage.adoption.test.js already seeds with
// (bare 'main' keys, no ownerId on attempts) -- rating 1800 is far enough
// from DEFAULT_RATING (1200) that the post-attempt ranges (bounded +/-24 by
// rating.js's K_FACTOR) never overlap: 1176-1224 (corrupted) vs 1776-1824
// (correct), an unambiguous classifier.
async function seedLegacyProfile(rating) {
  const db = await openRawDb()
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORES, 'readwrite')
    t.objectStore('profile').put(
      { rating, totalSolved: 12, totalFailed: 3, currentStreak: 4, bestStreak: 6 },
      'main',
    )
    t.objectStore('attempts').add({
      puzzleId: 'legacy0', themes: ['fork'], solved: true, hintUsed: false,
      ratingDelta: 10, timeTakenMs: 500, at: Date.now(),
    })
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

// Mirrors App.jsx's actual boot effect body for the flag-off branch
// (App.jsx:144-173) exactly: usePuzzleEngine() is called first in the
// component body (registers its effect first, same as App.jsx:30-52 running
// before App's own boot effect at line 144), then a useEffect whose async
// body is App.jsx:147-156's own flag-off path verbatim -- `identity =
// GUEST_IDENTITY` with zero intervening awaits, then `await
// adoptLegacyDataIfSafe(identity)`.
function Harness({ handleRef, timingRef }) {
  const engine = usePuzzleEngine()
  handleRef.current = engine

  useEffect(() => {
    let cancelled = false
    async function boot() {
      const identity = storage.GUEST_IDENTITY
      const t1 = performance.now()
      await storage.adoptLegacyDataIfSafe(identity)
      const t2 = performance.now()
      if (!cancelled) timingRef.current = t2 - t1
    }
    boot()
    return () => { cancelled = true }
  }, [])

  return null
}

// Adversarial control, NOT a claim about production behavior: deliberately
// never calls adoptLegacyDataIfSafe at all, so commitAttempt's getProfile()
// read can only ever see the un-adopted (still-'main'-keyed) record, which
// resolves to DEFAULT_PROFILE for the 'guest' identity every time. This
// exists to prove runTrial()'s classifier (finalRating < 1500 => corrupted)
// actually fires when the underlying condition it's meant to detect --
// commitAttempt reading a stale/default profile instead of the real
// adopted one -- is genuinely present, rather than trusting an
// all-trials-came-back-correct result that might just mean the classifier
// itself is broken or unreachable. Mirrors the same "confirm the test can
// actually fail" instinct this project's other adversarial-case tests use
// (e.g. storage.adoption.test.js), applied here instead of the fabricated
// addendum's invented "positive control."
function HarnessNoAdoption({ handleRef }) {
  const engine = usePuzzleEngine()
  handleRef.current = engine
  return null
}

async function runTrial({ delayMs }) {
  await clearAllStores()
  await seedLegacyProfile(1800)

  const handleRef = { current: null }
  const timingRef = { current: null }
  const t0 = performance.now()

  render(<Harness handleRef={handleRef} timingRef={timingRef} />)

  // "Hint clickable" -- the puzzle has loaded and the board is interactive.
  await waitFor(() => expect(handleRef.current?.status).toBe('solving'))
  const tReady = performance.now()

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  const tPress = performance.now()
  act(() => {
    handleRef.current.pressHint()
  })

  // coachNote is the LAST state commitAttempt sets (usePuzzleEngine.js:229,
  // after recordAttempt has already resolved and written) -- a reliable
  // "the write has fully landed" signal distinct from hintUsedThisAttempt
  // (set synchronously, before the async write even starts).
  await waitFor(() => expect(handleRef.current.coachNote).not.toBe(''))
  const tCommitDone = performance.now()

  const finalRating = handleRef.current.userRating
  cleanup()

  return {
    delayMs,
    finalRating,
    corrupted: finalRating < 1500, // 1176-1224 (corrupted) vs 1776-1824 (correct) -- no overlap
    mountToReadyMs: tReady - t0,
    mountToPressMs: tPress - t0,
    commitDurationMs: tCommitDone - tPress,
    adoptionDurationMs: timingRef.current,
  }
}

describe('Race B -- measured via real usePuzzleEngine + fake-indexeddb + real timers (no browser automation)', () => {
  beforeEach(async () => {
    await clearAllStores()
  })

  afterEach(() => {
    cleanup()
  })

  it('positive control: with NO legacy data, a fresh guest correctly gets DEFAULT_RATING after Hint (validates the classifier itself)', async () => {
    // No seedLegacyProfile call -- genuinely fresh guest, 1200 is correct.
    const handleRef = { current: null }
    const timingRef = { current: null }
    render(<Harness handleRef={handleRef} timingRef={timingRef} />)
    await waitFor(() => expect(handleRef.current?.status).toBe('solving'))
    act(() => { handleRef.current.pressHint() })
    await waitFor(() => expect(handleRef.current.coachNote).not.toBe(''))
    expect(handleRef.current.userRating).toBeGreaterThanOrEqual(1176)
    expect(handleRef.current.userRating).toBeLessThanOrEqual(1224)
    cleanup()
  })

  it('ADVERSARIAL: with adoption never run at all, commitAttempt correctly reads the stale default -- proves the corrupted classification is actually reachable and detected, not silently unreachable', async () => {
    await seedLegacyProfile(1800)
    const handleRef = { current: null }
    render(<HarnessNoAdoption handleRef={handleRef} />)
    await waitFor(() => expect(handleRef.current?.status).toBe('solving'))
    act(() => { handleRef.current.pressHint() })
    await waitFor(() => expect(handleRef.current.coachNote).not.toBe(''))
    // Must land in the CORRUPTED band (1176-1224), not the correct one
    // (1776-1824) -- if this assertion ever failed, every "zero corrupted"
    // result above would be meaningless (the classifier/harness would be
    // blind to corruption, not confirming its absence).
    expect(handleRef.current.userRating).toBeGreaterThanOrEqual(1176)
    expect(handleRef.current.userRating).toBeLessThanOrEqual(1224)
    cleanup()
  })

  it('floor: pressHint fired with zero added delay, immediately once solving (fastest possible, no human)', async () => {
    const results = []
    for (let i = 0; i < 5; i++) {
      results.push(await runTrial({ delayMs: 0 }))
    }
    console.log('Race B -- delayMs=0 (floor, x5):', JSON.stringify(results, null, 2))
    for (const r of results) {
      expect(r.finalRating).toBeGreaterThanOrEqual(1176)
      expect(r.finalRating).toBeLessThanOrEqual(1824)
    }
  })

  it('fastest plausible real human interaction (~150ms)', async () => {
    const results = []
    for (let i = 0; i < 3; i++) {
      results.push(await runTrial({ delayMs: 150 }))
    }
    console.log('Race B -- delayMs=150 (x3):', JSON.stringify(results, null, 2))
  })

  it('"ordinary human" proxy (~800ms)', async () => {
    const results = []
    for (let i = 0; i < 3; i++) {
      results.push(await runTrial({ delayMs: 800 }))
    }
    console.log('Race B -- delayMs=800 (x3):', JSON.stringify(results, null, 2))
  })

  it('typical solve time (~3000ms)', async () => {
    const results = []
    for (let i = 0; i < 3; i++) {
      results.push(await runTrial({ delayMs: 3000 }))
    }
    console.log('Race B -- delayMs=3000 (x3):', JSON.stringify(results, null, 2))
  }, 15000)
})
