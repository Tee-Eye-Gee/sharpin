import { defineConfig } from 'vitest/config'

// Separate from vite.config.js deliberately -- keeps the production app's
// build config untouched by test-only concerns (environment, globals).
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Default for every test file -- storage.js reads this once at module
    // eval time. Individual tests that need the flag off (guest
    // zero-network-calls) override it locally via vi.stubEnv + a dynamic
    // re-import, in their own isolated test file.
    env: {
      VITE_ENABLE_ACCOUNT_SYNC: 'true',
      // Harmless fixture values -- src/lib/supabaseClient.js's createClient()
      // throws synchronously on a missing/empty URL, and most test files
      // never actually exercise the real shared client (they mock
      // ../lib/supabaseClient outright). This just keeps a plain,
      // unmocked `import './storage.js'` from crashing at module-eval time
      // in the one file that deliberately builds its OWN separate client
      // instead of mocking this one.
      VITE_SUPABASE_URL: 'https://fixture-project.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'fixture-anon-key',
    },
  },
})
