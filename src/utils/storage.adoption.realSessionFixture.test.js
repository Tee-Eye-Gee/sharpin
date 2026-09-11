import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'

// The fixture agreed on before Commit 3 was built (storage-partitioning-
// investigation.md, addendum 3 §4, refined in conversation): reproduce the
// EXACT real-auth-js precondition this whole mitigation chain exists for --
// refresh fails AND the access token's real expiry has already passed --
// without waiting on wall-clock time, using the officially-documented
// `global: { fetch }` constructor option rather than mocking our own code or
// monkey-patching globalThis.fetch. This is Part A only (account-independent):
// proves (1) the real, installed @supabase/supabase-js resolves session:null
// under this exact condition, and (2) that null correctly drives
// adoptLegacyDataIfSafe's actual defer-vs-proceed branching for BOTH
// sub-cases -- not just that getSession() resolves null in isolation, per
// the explicit requirement attached to this fixture before it was approved.
//
// Part B (does a subsequent real Login against a live account correctly
// trigger adoption on the next, confirmed boot) is live-account-dependent
// and stays gated behind the standing live-write confirm-before-not-after
// rule -- not built here, verified manually/narratively when that's run,
// per the explicit decision made when this split was agreed.

const FAKE_URL = 'https://fixture-project.supabase.co'
const FAKE_ANON_KEY = 'fixture-anon-key'
const REFRESH_ENDPOINT_SUFFIX = '/auth/v1/token?grant_type=refresh_token'

function pastRealExpirySession() {
  return {
    access_token: 'expired-access-token',
    refresh_token: 'dead-refresh-token',
    // A full hour past the REAL expiry, not just the eager pre-emptive
    // margin -- lands on the "accessTokenStillValid === false" branch
    // __loadSession() falls through to on refresh failure, not the
    // proactive-preserve fallback the second investigation addendum found.
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    token_type: 'bearer',
    user: { id: 'stranded-acct-1' },
  }
}

function makeInMemoryStorage(seedSession) {
  const map = new Map()
  if (seedSession) map.set('sb-fixture-project-auth-token', JSON.stringify(seedSession))
  return {
    getItem: (key) => Promise.resolve(map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); return Promise.resolve() },
    removeItem: (key) => { map.delete(key); return Promise.resolve() },
  }
}

// Returns a 400 invalid_grant for the refresh call specifically -- the exact
// real failure this whole edge case requires -- and throws on anything else,
// so a future dependency bump changing the call shape fails loudly here
// rather than silently mocking around the drift.
function makeRefreshFailureFetch() {
  return async (url) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.includes(REFRESH_ENDPOINT_SUFFIX)) {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch to ${urlStr} in this fixture`)
  }
}

function buildFixtureClient() {
  return createClient(FAKE_URL, FAKE_ANON_KEY, {
    auth: {
      storage: makeInMemoryStorage(pastRealExpirySession()),
      storageKey: 'sb-fixture-project-auth-token',
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: makeRefreshFailureFetch() },
  })
}

// Mirrors App.jsx's own boot() derivation exactly (App.jsx:110-119) --
// this fixture is only meaningful if it exercises the same logic the real
// app runs, not a paraphrase of it.
async function resolveIdentityLikeAppBoot(client) {
  const { data } = await client.auth.getSession()
  return data.session ? data.session.user.id : 'guest'
}

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

async function seedLegacyAttempt(synced) {
  const db = await openRawDb()
  await new Promise((resolve, reject) => {
    const t = db.transaction(['attempts'], 'readwrite')
    const attempt = { puzzleId: 'stranded1', themes: ['fork'], solved: true, hintUsed: false, ratingDelta: 10, timeTakenMs: 500, at: Date.now() }
    if (synced !== undefined) attempt.synced = synced
    t.objectStore('attempts').add(attempt)
    t.oncomplete = resolve
    t.onerror = () => reject(t.error)
  })
  db.close()
}

beforeEach(async () => {
  await clearAllStores()
})

afterEach(() => {
  fixtureClient?.auth.stopAutoRefresh?.()
})

let fixtureClient

describe('real @supabase/supabase-js under the exact past-real-expiry + failed-refresh precondition', () => {
  it('getSession() resolves to a null session -- confirms the precondition is real and reproducible against the actual installed library', async () => {
    fixtureClient = buildFixtureClient()
    const { data, error } = await fixtureClient.auth.getSession()
    expect(data.session).toBeNull()
    expect(error).toBeTruthy()
  })
})

describe('that real null session, fed through the exact identity derivation App.jsx uses, drives adoptLegacyDataIfSafe correctly', () => {
  it('defers adoption when a legacy attempts row carries raw synced === true -- the stranded-account case this fixture exists for', async () => {
    await seedLegacyAttempt(true)

    fixtureClient = buildFixtureClient()
    const identity = await resolveIdentityLikeAppBoot(fixtureClient)
    expect(identity).toBe('guest') // confirms boot() really would compute GUEST_IDENTITY here, not throw or hang

    const { adoptLegacyDataIfSafe, GUEST_IDENTITY, getAllAttempts } = await import('./storage.js')
    const result = await adoptLegacyDataIfSafe(identity)

    expect(result).toEqual({ adopted: false, deferred: true })
    expect(await getAllAttempts({ identity: GUEST_IDENTITY })).toHaveLength(0) // untouched, not misattributed to guest
  })

  it('proceeds into GUEST_IDENTITY when no legacy row carries that evidence -- the genuine-guest case, unaffected by this fixture\'s null session', async () => {
    await seedLegacyAttempt(false)

    fixtureClient = buildFixtureClient()
    const identity = await resolveIdentityLikeAppBoot(fixtureClient)
    expect(identity).toBe('guest')

    const { adoptLegacyDataIfSafe, GUEST_IDENTITY, getAllAttempts } = await import('./storage.js')
    const result = await adoptLegacyDataIfSafe(identity)

    expect(result).toEqual({ adopted: true, deferred: false })
    expect(await getAllAttempts({ identity: GUEST_IDENTITY })).toHaveLength(1)
  })
})
