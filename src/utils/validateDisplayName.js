// src/utils/validateDisplayName.js
//
// Client-side mirror of supabase/functions/_shared/validate-display-name.ts
// -- same three checks (length, character set, profanity), same distinct
// per-failure reasons. This is the "immediate try again feedback" layer
// (spec: docs/specs/Sharpin_Spec_ProfileDisplayName.md) -- the Edge
// Function's own copy is the actual enforcement point; this one exists
// only so the user doesn't have to submit to find out.

import { Filter } from 'bad-words'

const MIN_LENGTH = 3
const MAX_LENGTH = 20
const CHARSET_REGEX = /^[A-Za-z0-9 _-]+$/

const filter = new Filter()

/**
 * Validates an optional display name. Empty string/null/undefined all mean
 * "no display name" -- valid, since it's optional (never required to
 * create an account or log in; removable later).
 *
 * @param {string | null | undefined} raw
 * @returns {{ ok: true, value: string | null } | { ok: false, error: string }}
 */
export function validateDisplayName(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null }
  }

  if (raw.length < MIN_LENGTH) {
    return { ok: false, error: `Must be at least ${MIN_LENGTH} characters` }
  }

  if (raw.length > MAX_LENGTH) {
    return { ok: false, error: `Must be at most ${MAX_LENGTH} characters` }
  }

  if (!CHARSET_REGEX.test(raw)) {
    return { ok: false, error: 'Only letters, numbers, spaces, hyphens, and underscores' }
  }

  if (filter.isProfane(raw)) {
    return { ok: false, error: 'Contains disallowed language -- choose another' }
  }

  return { ok: true, value: raw }
}
