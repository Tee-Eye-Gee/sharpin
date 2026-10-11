// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode, useEffect } from 'react'
import { render, cleanup, waitFor } from '@testing-library/react'

// authUrl.js reads the URL once, at module evaluation, so every test sets
// the URL (and the flag) first and then imports a fresh copy of the module.

const calls = []
const mockInitialize = vi.fn(async () => { calls.push('initialize'); return { error: null } })
const mockVerifyOtp = vi.fn(async (params) => {
  calls.push('verifyOtp')
  return { data: { session: { user: { id: 'acct-new' } }, user: { id: 'acct-new' } }, error: null, params }
})

vi.mock('./supabaseClient', () => ({
  supabase: {
    auth: {
      initialize: (...a) => mockInitialize(...a),
      verifyOtp: (...a) => mockVerifyOtp(...a),
    },
  },
}))

// Absolute, so a path starting '//' is set as a path, not read as a
// protocol-relative URL.
async function loadWithUrl(path, { flag = 'true' } = {}) {
  window.history.replaceState(null, '', `${window.location.origin}${path}`)
  vi.stubEnv('VITE_ENABLE_ACCOUNT_SYNC', flag)
  vi.resetModules()
  const replaceSpy = vi.spyOn(window.history, 'replaceState')
  const mod = await import('./authUrl')
  return { mod, replaceSpy }
}

function currentPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

beforeEach(() => {
  calls.length = 0
  mockInitialize.mockClear()
  mockVerifyOtp.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  window.history.replaceState(null, '', '/')
})

describe('authUrl: emailed link consumer', () => {
  it('strips token_hash and type via replaceState at import, keeping other params and the hash', async () => {
    const { replaceSpy } = await loadWithUrl('/?keep=1&token_hash=th-abc&type=email#frag')
    console.log('[authUrl] replaceState calls:', JSON.stringify(replaceSpy.mock.calls.map((c) => c[2])), '| now at', currentPath())
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(currentPath()).toBe('/?keep=1#frag')
    // Stripping alone makes no Supabase call; verification waits for
    // consumeUrlToken().
    expect(mockVerifyOtp).not.toHaveBeenCalled()
  })

  // Found live 2026-10-11: a confirm link at http://localhost:5173//?token_hash=...
  // made replaceState throw a SecurityError at module load (blank screen).
  it('a "//" path (template "/" after a RedirectTo ending in "/") is cleaned to "/" without throwing, and still verified', async () => {
    const { mod, replaceSpy } = await loadWithUrl('//?token_hash=th-dbl&type=email')
    console.log('[authUrl] // path: replaceState arg', replaceSpy.mock.calls[0]?.[2], '| now at', currentPath())
    expect(currentPath()).toBe('/')
    expect(replaceSpy.mock.calls[0][2]).toBe(`${window.location.origin}/`)
    const result = await mod.consumeUrlToken()
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'th-dbl', type: 'email' })
    expect(result).toMatchObject({ type: 'email', ok: true })
  })

  it('a "///" path collapses to "/", keeping other params and the hash', async () => {
    await loadWithUrl('///?keep=1&token_hash=th-tri&type=email&also=2#frag')
    console.log('[authUrl] /// path: now at', currentPath())
    expect(currentPath()).toBe('/?keep=1&also=2#frag')
  })

  it('a deeper path keeps everything after its leading slash run', async () => {
    await loadWithUrl('//a//b?token_hash=th-deep&type=email&keep=1')
    expect(currentPath()).toBe('/a//b?keep=1')
  })

  it('if replaceState throws, the import still succeeds and the token is still verified once', async () => {
    window.history.replaceState(null, '', `${window.location.origin}/?token_hash=th-guard&type=email`)
    vi.stubEnv('VITE_ENABLE_ACCOUNT_SYNC', 'true')
    vi.resetModules()
    const replaceSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('simulated', 'SecurityError')
    })
    const mod = await import('./authUrl')
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    await mod.consumeUrlToken()
    await mod.consumeUrlToken()
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1)
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'th-guard', type: 'email' })
  })

  it('verifies type=email once, after initialize(), across a StrictMode double mount', async () => {
    const { mod } = await loadWithUrl('/?token_hash=th-abc&type=email')
    const results = []
    function Probe() {
      useEffect(() => {
        mod.consumeUrlToken().then((r) => results.push(r))
      }, [])
      return null
    }
    render(<StrictMode><Probe /></StrictMode>)
    await waitFor(() => expect(results.length).toBe(2))
    console.log('[authUrl] effect runs', results.length, '| verifyOtp calls', mockVerifyOtp.mock.calls.length, '| order', calls.join(' -> '))
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1)
    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'th-abc', type: 'email' })
    expect(calls).toEqual(['initialize', 'verifyOtp'])
    expect(results[0]).toBe(results[1])
    expect(results[0]).toMatchObject({ type: 'email', ok: true, skipped: false })
  })

  it('type=recovery is stripped but not verified (step 2b)', async () => {
    const { mod } = await loadWithUrl('/?token_hash=th-rec&type=recovery')
    expect(currentPath()).toBe('/')
    const result = await mod.consumeUrlToken()
    console.log('[authUrl] recovery result', JSON.stringify(result))
    expect(result).toMatchObject({ type: 'recovery', ok: false, skipped: true })
    expect(mockInitialize).not.toHaveBeenCalled()
    expect(mockVerifyOtp).not.toHaveBeenCalled()
  })

  it('a failed verification is reported, not thrown', async () => {
    mockVerifyOtp.mockImplementationOnce(async () => ({
      data: { session: null, user: null },
      error: { status: 403, code: 'otp_expired' },
    }))
    const { mod } = await loadWithUrl('/?token_hash=th-old&type=email')
    const result = await mod.consumeUrlToken()
    expect(result).toMatchObject({ type: 'email', ok: false, skipped: false, error: { code: 'otp_expired' } })
  })

  it('no link: resolves null, no URL change, no Supabase call', async () => {
    const { mod, replaceSpy } = await loadWithUrl('/?keep=1')
    expect(await mod.consumeUrlToken()).toBeNull()
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(mockInitialize).not.toHaveBeenCalled()
  })

  it('flag off: a complete no-op -- URL untouched, nothing verified', async () => {
    const { mod, replaceSpy } = await loadWithUrl('/?token_hash=th-abc&type=email', { flag: 'false' })
    expect(await mod.consumeUrlToken()).toBeNull()
    console.log('[authUrl] flag off: now at', currentPath())
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(currentPath()).toBe('/?token_hash=th-abc&type=email')
    expect(mockInitialize).not.toHaveBeenCalled()
    expect(mockVerifyOtp).not.toHaveBeenCalled()
  })
})
