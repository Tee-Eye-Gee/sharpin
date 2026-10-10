import { supabase } from './supabaseClient'

// Same flag/convention as App.jsx's ACCOUNT_SYNC_ENABLED. With the flag off
// this module does nothing at all -- the URL is left untouched and no
// Supabase call is made ("flag off means zero Supabase traffic").
const ACCOUNT_SYNC_ENABLED = import.meta.env.VITE_ENABLE_ACCOUNT_SYNC === 'true'

// Link types this build verifies. 'recovery' links are still stripped
// below, but not verified until the recovery view exists (Auth V2 step 2b)
// -- verifying one now would persist a recovery session that the app would
// then treat as an ordinary login (spec §5).
const VERIFIED_TYPES = new Set(['email'])

// Auth emails link to the site root as ?token_hash=<hash>&type=<type>
// (CLAUDE.md, "Email setup"). Read once, at module evaluation -- NOT inside
// a React effect: main.jsx renders under StrictMode, which runs App's boot
// effect twice in dev, and a token hash is single-use, so a second
// verifyOtp would fail. Both params are stripped immediately, before any
// verification, so a reload can never resubmit a consumed token; the
// values live only in memory from here on. Other params and the hash
// fragment are preserved.
function takeUrlToken() {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const tokenHash = url.searchParams.get('token_hash')
  if (tokenHash === null) return null
  const type = url.searchParams.get('type')
  url.searchParams.delete('token_hash')
  url.searchParams.delete('type')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return { tokenHash, type }
}

const pendingToken = ACCOUNT_SYNC_ENABLED ? takeUrlToken() : null

async function verifyPendingToken(token) {
  if (!token) return null
  const { tokenHash, type } = token
  if (!tokenHash || !VERIFIED_TYPES.has(type)) {
    return { type, ok: false, skipped: true, session: null, error: null }
  }
  try {
    // verifyOtp, unlike getSession/updateUser/signOut, does not wait for
    // the client's own initialization. Waiting here first means a refresh
    // of some previously stored session can't land after verifyOtp has
    // saved the new one and overwrite it.
    await supabase.auth.initialize()
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (error) return { type, ok: false, skipped: false, session: null, error }
    return { type, ok: Boolean(data?.session), skipped: false, session: data?.session ?? null, error: null }
  } catch (error) {
    return { type, ok: false, skipped: false, session: null, error }
  }
}

let resultPromise = null

/**
 * The result of this page load's emailed auth link, if any -- verified at
 * most once per page load however many times this is called (App's boot
 * effect calls it on every mount). Resolves to null when there was no
 * link (or the flag is off), else `{ type, ok, skipped, session, error }`.
 * On success the session is already saved by supabase-js, so a following
 * getSession() returns it.
 */
export function consumeUrlToken() {
  if (!resultPromise) resultPromise = verifyPendingToken(pendingToken)
  return resultPromise
}
