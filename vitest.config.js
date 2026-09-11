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
    },
  },
})
