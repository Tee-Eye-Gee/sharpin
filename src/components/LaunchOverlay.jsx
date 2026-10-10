import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { classifyAuthError } from '../utils/authErrors'
import { validateDisplayName } from '../utils/validateDisplayName'
import SequenceBoardInput from './SequenceBoardInput'
import SequenceConfirmInput from './SequenceConfirmInput'

const VIEWS = { MENU: 'menu', SIGN_IN: 'sign_in', SIGN_UP: 'sign_up', CHECK_EMAIL: 'check_email' }

// Loose on purpose: only gates the board until something email-shaped is
// typed. Supabase Auth is the real check.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Where the confirmation link should send the user back to (decision Q2):
// this same origin, so a dev sign-up's link returns to dev once the email
// templates use {{ .RedirectTo }}.
function emailRedirectTo() {
  return window.location.origin
}

/**
 * Launch screen (Auth V2): Guest (primary) / Create Account (secondary) /
 * Sign in (tertiary link). Email identifies the account; the 4-move
 * sequence, hashed on the device (SequenceBoardInput), is the password
 * (spec D1, D3). Rendered by App.jsx only while sessionStatus === 'none'.
 *
 * The guest-to-account Merge/Discard prompt is no longer here: under Auth
 * V2 an account's first session may appear at boot from a confirm link, so
 * App.jsx decides that (FirstSignInPrompt) for every sign-in path.
 *
 * @param {object} props
 * @param {() => void} props.onGuest - Guest tapped; dismiss with no action.
 * @param {(session: object) => void} props.onAuthenticated - a real session
 *   was obtained (sign-in, or a sign-up that returned one) and supabase-js
 *   already holds it; caller takes it from here.
 * @param {boolean} props.actionsDisabled - true while a puzzle attempt is
 *   in flight (not yet committed) -- Create Account and Sign in are both
 *   disabled in that case (Guest is never affected). See App.jsx for the
 *   derivation.
 * @param {string} [props.boardTheme]
 * @param {string} [props.linkError] - why this page load's emailed link
 *   didn't sign anyone in, shown on the menu.
 */
export default function LaunchOverlay({ onGuest, onAuthenticated, actionsDisabled, boardTheme, linkError }) {
  const [view, setView] = useState(VIEWS.MENU)
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Set when sign-in failed with email_not_confirmed (decision Q5): offers
  // to resend the confirmation email.
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  const [resendState, setResendState] = useState('idle') // 'idle' | 'sending' | 'sent'
  // Optional, entered alongside the sequence board on the Create Account
  // view (spec: docs/specs/Sharpin_Spec_ProfileDisplayName.md). Validated
  // live on every keystroke, same pattern as SettingsPanel's own copy --
  // this is purely the "immediate try again" layer; the Edge Function's
  // copy of these same checks is the actual enforcement point.
  const [createDisplayName, setCreateDisplayName] = useState('')

  const trimmedEmail = email.trim()
  const emailReady = EMAIL_SHAPE.test(trimmedEmail)

  function resetFormState() {
    setError('')
    setNeedsConfirmation(false)
    setResendState('idle')
  }

  function goTo(nextView) {
    resetFormState()
    setSubmitting(false)
    setView(nextView)
  }

  // signInWithPassword only saves a session on success, so a failure here
  // leaves whatever session existed before untouched (AC2). On failure,
  // `submitting` going back to false re-arms SequenceBoardInput with an
  // empty board.
  async function handleSignIn(hash) {
    resetFormState()
    setSubmitting(true)
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password: hash,
    })
    if (signInError || !data?.session) {
      const { kind, message } = classifyAuthError(signInError)
      setError(message)
      setNeedsConfirmation(kind === 'email_not_confirmed')
      setSubmitting(false)
      return
    }
    onAuthenticated(data.session)
  }

  async function handleResendConfirmation() {
    setError('')
    setResendState('sending')
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: trimmedEmail,
      options: { emailRedirectTo: emailRedirectTo() },
    })
    if (resendError) {
      setResendState('idle')
      setError(classifyAuthError(resendError).message)
      return
    }
    setResendState('sent')
  }

  async function handleSignUp(hash) {
    resetFormState()
    setSubmitting(true)

    // An invalid display name never blocks sign-up -- it's optional, so an
    // invalid entry simply isn't sent, same outcome as never having typed
    // one. The input's own live validation (below) already says why.
    const nameValidation = validateDisplayName(createDisplayName.trim())
    const displayNameToSend = nameValidation.ok ? nameValidation.value : null

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: trimmedEmail,
      password: hash,
      options: {
        emailRedirectTo: emailRedirectTo(),
        // Carried to the account's first sign-in, where App.jsx copies it
        // into profiles via update-profile (spec §5).
        data: displayNameToSend ? { display_name: displayNameToSend } : {},
      },
    })

    if (signUpError) {
      // Includes 429 (sign-up or email-send rate limit): shown, never
      // folded into "check your email" -- no email was sent.
      setError(classifyAuthError(signUpError).message)
      setSubmitting(false)
      return
    }

    setSubmitting(false)
    // Email confirmation is on (spec D2), so there's normally no session
    // yet -- and for an already-registered email Supabase returns the same
    // no-session success, so this screen never reveals whether one exists.
    // A session here would mean confirmation got switched off; take it.
    if (data?.session) {
      onAuthenticated(data.session)
      return
    }
    setView(VIEWS.CHECK_EMAIL)
  }

  // Live, on every keystroke -- same "immediate try again" layer as
  // SettingsPanel's own Profile section. Empty input shows no error at all
  // (a not-yet-typed optional field isn't invalid).
  const createDisplayNameTrimmed = createDisplayName.trim()
  const createDisplayNameValidation = validateDisplayName(createDisplayNameTrimmed)
  const createDisplayNameError = createDisplayNameTrimmed && !createDisplayNameValidation.ok
    ? createDisplayNameValidation.error
    : ''

  const emailField = (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-fg-muted" htmlFor="launch-email">
        Email
      </label>
      <input
        id="launch-email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value)
          resetFormState()
        }}
        disabled={submitting}
        placeholder="you@example.com"
        className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent disabled:opacity-50"
      />
      {!emailReady && <p className="text-xs text-fg-muted">Enter your email to start drawing.</p>}
    </div>
  )

  const backButton = (
    <button onClick={() => goTo(VIEWS.MENU)} className="text-xs text-fg-muted hover:text-fg underline text-center">
      Back
    </button>
  )

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" />

      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm max-h-full overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-xl">
          <h2 className="text-lg font-bold tracking-tight mb-3">
            <span className="text-accent">Sharp</span>
            <span className="text-fg">in</span>
          </h2>

          {view === VIEWS.MENU && (
            <div className="flex flex-col gap-2">
              {linkError && <p className="text-xs text-red-400">{linkError}</p>}

              <button
                onClick={onGuest}
                className="rounded-lg border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-accent transition-all active:scale-95"
              >
                Play as Guest
              </button>

              <button
                onClick={() => goTo(VIEWS.SIGN_UP)}
                disabled={actionsDisabled}
                className="rounded-lg border border-border px-3 py-2 text-sm text-fg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Account
              </button>

              {actionsDisabled && (
                <p className="text-xs text-fg-muted text-center">
                  Create Account and Sign in are available once this puzzle is scored.
                </p>
              )}

              <button
                onClick={() => goTo(VIEWS.SIGN_IN)}
                disabled={actionsDisabled}
                aria-label="Sign in with an existing account"
                className="text-xs text-fg-muted hover:text-fg underline text-center mt-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Sign in
              </button>
            </div>
          )}

          {view === VIEWS.SIGN_IN && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-muted">Enter your email, then draw your 4-move sequence.</p>
              {emailField}
              <SequenceBoardInput
                onSequenceComplete={handleSignIn}
                disabled={submitting || !emailReady}
                boardTheme={boardTheme}
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              {needsConfirmation && (
                resendState === 'sent' ? (
                  <p className="text-xs text-accent">Confirmation email sent. Check your inbox.</p>
                ) : (
                  <button
                    onClick={handleResendConfirmation}
                    disabled={resendState === 'sending'}
                    className="rounded-lg border border-border px-3 py-2 text-sm text-fg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {resendState === 'sending' ? 'Sending…' : 'Resend confirmation email'}
                  </button>
                )
              )}
              {backButton}
            </div>
          )}

          {view === VIEWS.SIGN_UP && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-fg-muted">
                Your email identifies your account. Your 4-move sequence is your password.
              </p>
              {emailField}

              <div className="flex flex-col gap-1">
                <label className="text-xs text-fg-muted" htmlFor="create-display-name">
                  Display name (optional)
                </label>
                <input
                  id="create-display-name"
                  type="text"
                  value={createDisplayName}
                  onChange={(e) => setCreateDisplayName(e.target.value)}
                  disabled={submitting}
                  placeholder="e.g. ChessFan42"
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent disabled:opacity-50"
                />
                {createDisplayNameError && <p className="text-xs text-red-400">{createDisplayNameError}</p>}
              </div>

              <SequenceConfirmInput
                onConfirmed={handleSignUp}
                disabled={submitting || !emailReady}
                boardTheme={boardTheme}
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              {backButton}
            </div>
          )}

          {view === VIEWS.CHECK_EMAIL && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg">Check your email.</p>
              <p className="text-xs text-fg-muted">
                We sent a confirmation link to {trimmedEmail}. Open it on any device to finish creating your account.
              </p>
              <button
                onClick={() => goTo(VIEWS.SIGN_IN)}
                className="rounded-lg border border-border px-3 py-2 text-sm text-fg transition-all active:scale-95"
              >
                Back to sign in
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
