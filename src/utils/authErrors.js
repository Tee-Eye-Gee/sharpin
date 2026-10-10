// User-facing copy for Supabase Auth errors (Auth V2 step 2). One place, so
// every auth screen says the same thing for the same failure. Matched on
// the AuthError's `code` (node_modules/@supabase/auth-js/src/lib/
// error-codes.ts) and, for rate limits, also the HTTP status: a 429 must
// always be surfaced, never folded into a "check your email" success.

export const AUTH_MESSAGES = {
  invalid_credentials: 'Email or sequence not recognized.',
  email_not_confirmed: 'Confirm your email first. Check your inbox.',
  rate_limited: 'Too many attempts -- try again later.',
  same_password: 'Choose a different sequence.',
  link_expired: 'That link has expired or was already used. Request a new one.',
  unknown: 'Something went wrong -- try again.',
}

const RATE_LIMIT_CODES = new Set(['over_request_rate_limit', 'over_email_send_rate_limit'])

/**
 * @param {unknown} error - an AuthError (or anything thrown by an auth call)
 * @returns {{ kind: keyof AUTH_MESSAGES, message: string }}
 */
export function classifyAuthError(error) {
  const code = error?.code
  let kind = 'unknown'
  if (error?.status === 429 || RATE_LIMIT_CODES.has(code)) kind = 'rate_limited'
  else if (code === 'invalid_credentials') kind = 'invalid_credentials'
  else if (code === 'email_not_confirmed') kind = 'email_not_confirmed'
  else if (code === 'same_password') kind = 'same_password'
  else if (code === 'otp_expired') kind = 'link_expired'
  return { kind, message: AUTH_MESSAGES[kind] }
}
