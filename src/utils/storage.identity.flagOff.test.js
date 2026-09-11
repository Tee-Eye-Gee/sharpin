import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'

// Separate file from storage.identity.test.js deliberately: vitest.config.js
// sets VITE_ENABLE_ACCOUNT_SYNC=true globally (storage.js reads it once at
// module-eval time), so exercising the flag-off path needs its own
// vi.stubEnv + a fresh dynamic import, isolated from every other test that
// depends on the flag being on.

const mockGetSession = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...args) => mockGetSession(...args) },
    from: () => ({ insert: async () => ({ error: null }) }),
  },
}))

describe('storage.js -- account-sync feature flag off', () => {
  it('makes zero Supabase auth calls for guest reads/writes, even with real IndexedDB activity', async () => {
    vi.stubEnv('VITE_ENABLE_ACCOUNT_SYNC', 'false')
    vi.resetModules()
    const storage = await import('./storage.js')

    await storage.recordAttempt({
      puzzleId: 'g1', themes: ['fork'], solved: true, hintUsed: false,
      newRating: 1210, ratingDelta: 10, timeTakenMs: 1000,
    })
    await storage.getProfile()
    await storage.getAllAttempts()
    await storage.getRecentAttempts()
    await storage.getPreferences()
    await storage.getThemeStats()

    expect(mockGetSession).not.toHaveBeenCalled()

    vi.unstubAllEnvs()
  })
})
