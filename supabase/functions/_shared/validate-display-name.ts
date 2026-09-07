// supabase/functions/_shared/validate-display-name.ts
//
// Shared display-name validation for create-account and update-profile
// (spec: docs/specs/Sharpin_Spec_ProfileDisplayName.md). This is the
// server-side enforcement point the spec calls "the actual enforcement
// point, since client-side checks are trivially bypassable" -- both
// Edge Functions call this instead of duplicating the three checks.
//
// Distinct reasons per failure (length-short, length-long, character-set,
// profanity), not one collapsed regex failure, so the caller can show a
// specific message rather than a generic "invalid" -- matches the spec's
// two-layer validation design (client-side mirrors these same rules for
// immediate feedback; this is the layer that actually matters).

import { Filter } from 'npm:bad-words@4.1.5'

const MIN_LENGTH = 3
const MAX_LENGTH = 20
// Character-set only -- length is checked separately above so each failure
// gets its own specific reason instead of one regex swallowing both.
const CHARSET_REGEX = /^[A-Za-z0-9 _-]+$/

const filter = new Filter()

export type DisplayNameValidation =
  | { ok: true; value: string | null }
  | { ok: false; error: string }

/**
 * Validates an optional display name. null/undefined/empty string all mean
 * "no display name" -- valid, since it's optional both at creation and
 * removable later (spec: "Never required to create an account or log in";
 * "removing a previously-set name is valid").
 */
export function validateDisplayName(raw: unknown): DisplayNameValidation {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null }
  }

  if (typeof raw !== 'string') {
    return { ok: false, error: 'display name must be a string' }
  }

  if (raw.length < MIN_LENGTH) {
    return { ok: false, error: `display name must be at least ${MIN_LENGTH} characters` }
  }

  if (raw.length > MAX_LENGTH) {
    return { ok: false, error: `display name must be at most ${MAX_LENGTH} characters` }
  }

  if (!CHARSET_REGEX.test(raw)) {
    return { ok: false, error: 'display name may only contain letters, numbers, spaces, hyphens, and underscores' }
  }

  if (filter.isProfane(raw)) {
    return { ok: false, error: 'display name contains disallowed language -- choose another' }
  }

  return { ok: true, value: raw }
}
