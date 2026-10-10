// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { createHash } from 'node:crypto'

// Auth V2 launch screen: sign-in and sign-up against a mocked supabase.auth.
// The board is stubbed (drag gestures aren't the subject here); it emits
// the real password the real board would produce for TEST_FIXTURE_KEEP's
// sequence -- the lowercase hex SHA-256 of 'c2c4|b2b4|a1a2|g1g2' (see
// src/utils/sequenceHash.test.js for the hashing itself).
const FIXTURE_HASH = createHash('sha256').update('c2c4|b2b4|a1a2|g1g2').digest('hex')
const EMAIL = 'horacetiggsiv+unit@gmail.com'

let queuedHashes = []
vi.mock('./SequenceBoardInput', () => ({
  default: ({ onSequenceComplete, disabled }) => (
    <button disabled={disabled} onClick={() => onSequenceComplete(queuedHashes.shift() ?? FIXTURE_HASH)}>
      complete-sequence
    </button>
  ),
}))

// Mirrors supabase-js: signInWithPassword saves a session only on success.
let currentSession = null
const signedInSession = { user: { id: 'acct-1', user_metadata: {} }, access_token: 'at', refresh_token: 'rt' }
let signInResult = null
let signUpResult = null
let resendResult = null
const mockSignIn = vi.fn(async () => {
  const result = signInResult()
  if (result.data?.session) currentSession = result.data.session
  return result
})
const mockSignUp = vi.fn(async () => signUpResult())
const mockResend = vi.fn(async () => resendResult())

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: currentSession } }),
      signInWithPassword: (...a) => mockSignIn(...a),
      signUp: (...a) => mockSignUp(...a),
      resend: (...a) => mockResend(...a),
    },
    // No `functions` and no `from`: the V1 create-account/verify-move-
    // sequence calls are gone, and the launch screen never touches tables.
  },
}))

const { default: LaunchOverlay } = await import('./LaunchOverlay')

function renderOverlay(props = {}) {
  const onAuthenticated = vi.fn()
  render(
    <LaunchOverlay onGuest={() => {}} onAuthenticated={onAuthenticated} actionsDisabled={false} boardTheme="tournament" {...props} />,
  )
  return onAuthenticated
}

function typeEmail(value = EMAIL) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value } })
}

function authError(status, code) {
  return { data: { user: null, session: null }, error: { status, code, message: code ?? 'error' } }
}

beforeEach(() => {
  currentSession = null
  queuedHashes = []
  signInResult = () => ({ data: { user: signedInSession.user, session: signedInSession }, error: null })
  signUpResult = () => ({ data: { user: { id: 'acct-new' }, session: null }, error: null })
  resendResult = () => ({ data: {}, error: null })
  mockSignIn.mockClear()
  mockSignUp.mockClear()
  mockResend.mockClear()
})

afterEach(() => cleanup())

describe('LaunchOverlay: sign in', () => {
  it('the board stays disabled until an email is entered', () => {
    renderOverlay()
    fireEvent.click(screen.getByText('Sign in'))
    expect(screen.getByText('complete-sequence').disabled).toBe(true)
    typeEmail()
    expect(screen.getByText('complete-sequence').disabled).toBe(false)
  })

  it('calls signInWithPassword with the email and the hex hash, then onAuthenticated(session)', async () => {
    const onAuthenticated = renderOverlay()
    fireEvent.click(screen.getByText('Sign in'))
    typeEmail(`  ${EMAIL}  `)
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    console.log('[sign-in] signInWithPassword args', JSON.stringify(mockSignIn.mock.calls[0][0]).replace(FIXTURE_HASH, `<${FIXTURE_HASH.slice(0, 12)}…>`))
    expect(mockSignIn).toHaveBeenCalledWith({ email: EMAIL, password: FIXTURE_HASH })
    expect(FIXTURE_HASH).toMatch(/^[0-9a-f]{64}$/)
    expect(onAuthenticated).toHaveBeenCalledWith(signedInSession)
  })

  it('invalid_credentials: generic message, no session change, board re-armed', async () => {
    signInResult = () => authError(400, 'invalid_credentials')
    const onAuthenticated = renderOverlay()
    fireEvent.click(screen.getByText('Sign in'))
    typeEmail()
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(screen.getByText('Email or sequence not recognized.')).toBeTruthy())
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(currentSession).toBeNull()
    expect(screen.getByText('complete-sequence').disabled).toBe(false)
    expect(screen.queryByText('Resend confirmation email')).toBeNull()
  })

  it('429: rate-limit message', async () => {
    signInResult = () => authError(429, 'over_request_rate_limit')
    const onAuthenticated = renderOverlay()
    fireEvent.click(screen.getByText('Sign in'))
    typeEmail()
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(screen.getByText('Too many attempts -- try again later.')).toBeTruthy())
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it('email_not_confirmed: Q5 copy, and Resend calls auth.resend with emailRedirectTo', async () => {
    signInResult = () => authError(400, 'email_not_confirmed')
    renderOverlay()
    fireEvent.click(screen.getByText('Sign in'))
    typeEmail()
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(screen.getByText('Confirm your email first. Check your inbox.')).toBeTruthy())
    fireEvent.click(screen.getByText('Resend confirmation email'))

    await waitFor(() => expect(screen.getByText('Confirmation email sent. Check your inbox.')).toBeTruthy())
    console.log('[resend] args', JSON.stringify(mockResend.mock.calls[0][0]))
    expect(mockResend).toHaveBeenCalledWith({
      type: 'signup',
      email: EMAIL,
      options: { emailRedirectTo: window.location.origin },
    })
  })

  it('a rate-limited resend is shown, not reported as sent', async () => {
    signInResult = () => authError(400, 'email_not_confirmed')
    resendResult = () => ({ data: null, error: { status: 429, code: 'over_email_send_rate_limit' } })
    renderOverlay()
    fireEvent.click(screen.getByText('Sign in'))
    typeEmail()
    fireEvent.click(screen.getByText('complete-sequence'))
    await waitFor(() => expect(screen.getByText('Resend confirmation email')).toBeTruthy())

    fireEvent.click(screen.getByText('Resend confirmation email'))
    await waitFor(() => expect(screen.getByText('Too many attempts -- try again later.')).toBeTruthy())
    expect(screen.queryByText('Confirmation email sent. Check your inbox.')).toBeNull()
  })
})

describe('LaunchOverlay: create account', () => {
  it('passes the display name in options.data and emailRedirectTo, then shows CHECK_EMAIL; never Merge', async () => {
    const onAuthenticated = renderOverlay()
    fireEvent.click(screen.getByText('Create Account'))
    typeEmail()
    fireEvent.change(screen.getByLabelText('Display name (optional)'), { target: { value: 'ChessFan42' } })

    fireEvent.click(screen.getByText('complete-sequence'))
    expect(mockSignUp).not.toHaveBeenCalled() // first draw only
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(screen.getByText('Check your email.')).toBeTruthy())
    console.log('[sign-up] signUp args', JSON.stringify(mockSignUp.mock.calls[0][0]).replace(FIXTURE_HASH, `<${FIXTURE_HASH.slice(0, 12)}…>`))
    expect(mockSignUp).toHaveBeenCalledWith({
      email: EMAIL,
      password: FIXTURE_HASH,
      options: { emailRedirectTo: window.location.origin, data: { display_name: 'ChessFan42' } },
    })
    expect(screen.getByText(new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))).toBeTruthy()
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(screen.queryByText('Merge')).toBeNull()
  })

  it('an empty or invalid display name is not sent', async () => {
    renderOverlay()
    fireEvent.click(screen.getByText('Create Account'))
    typeEmail()
    fireEvent.change(screen.getByLabelText('Display name (optional)'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('complete-sequence'))
    fireEvent.click(screen.getByText('complete-sequence'))
    await waitFor(() => expect(mockSignUp).toHaveBeenCalledTimes(1))
    expect(mockSignUp.mock.calls[0][0].options.data).toEqual({})
  })

  it('429 is shown, not CHECK_EMAIL', async () => {
    signUpResult = () => authError(429, 'over_email_send_rate_limit')
    renderOverlay()
    fireEvent.click(screen.getByText('Create Account'))
    typeEmail()
    fireEvent.click(screen.getByText('complete-sequence'))
    fireEvent.click(screen.getByText('complete-sequence'))

    await waitFor(() => expect(screen.getByText('Too many attempts -- try again later.')).toBeTruthy())
    expect(screen.queryByText('Check your email.')).toBeNull()
  })

  it('mismatched second draw: no sign-up call', async () => {
    queuedHashes = ['a'.repeat(64), 'b'.repeat(64)]
    renderOverlay()
    fireEvent.click(screen.getByText('Create Account'))
    typeEmail()
    fireEvent.click(screen.getByText('complete-sequence'))
    fireEvent.click(screen.getByText('complete-sequence'))

    expect(screen.getByText("Those didn't match -- draw your sequence again.")).toBeTruthy()
    await new Promise((r) => setTimeout(r, 20))
    expect(mockSignUp).not.toHaveBeenCalled()
  })
})

describe('LaunchOverlay: menu', () => {
  it('shows why an emailed link failed', () => {
    renderOverlay({ linkError: 'That link has expired or was already used. Request a new one.' })
    expect(screen.getByText('That link has expired or was already used. Request a new one.')).toBeTruthy()
  })

  it('has no "Forgot sequence?" link yet (step 2b)', () => {
    renderOverlay()
    fireEvent.click(screen.getByText('Sign in'))
    expect(screen.queryByText(/forgot/i)).toBeNull()
  })
})
