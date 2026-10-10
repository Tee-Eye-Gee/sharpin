import { describe, it, expect } from 'vitest'
import { classifyAuthError, AUTH_MESSAGES } from './authErrors'

describe('classifyAuthError', () => {
  it.each([
    [{ status: 400, code: 'invalid_credentials' }, 'invalid_credentials', 'Email or sequence not recognized.'],
    [{ status: 400, code: 'email_not_confirmed' }, 'email_not_confirmed', 'Confirm your email first. Check your inbox.'],
    [{ status: 429, code: 'over_request_rate_limit' }, 'rate_limited', 'Too many attempts -- try again later.'],
    [{ status: 429, code: 'over_email_send_rate_limit' }, 'rate_limited', 'Too many attempts -- try again later.'],
    [{ status: 429 }, 'rate_limited', 'Too many attempts -- try again later.'],
    [{ status: 422, code: 'same_password' }, 'same_password', 'Choose a different sequence.'],
    [{ status: 403, code: 'otp_expired' }, 'link_expired', 'That link has expired or was already used. Request a new one.'],
    [{ status: 500 }, 'unknown', 'Something went wrong -- try again.'],
    [null, 'unknown', 'Something went wrong -- try again.'],
  ])('%j -> %s', (error, kind, message) => {
    expect(classifyAuthError(error)).toEqual({ kind, message })
  })

  it('a rate-limit status wins over any other code', () => {
    expect(classifyAuthError({ status: 429, code: 'invalid_credentials' }).kind).toBe('rate_limited')
  })

  it('every kind has copy', () => {
    for (const message of Object.values(AUTH_MESSAGES)) expect(message).toBeTruthy()
  })
})
