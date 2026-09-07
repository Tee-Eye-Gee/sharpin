// supabase/functions/update-profile/index.ts
//
// Update Profile: lets an already-authenticated user set, change, or clear
// their own display_name (spec: docs/specs/Sharpin_Spec_ProfileDisplayName.md).
// Distinct from create-account, which only ever creates a NEW row pre-auth
// with its own rate-limit/collision logic -- this is a plain authenticated
// UPDATE against an EXISTING row, so none of that applies (spec's
// investigation notes: "No rate-limiting or collision-check logic needed").
//
// Auth: the caller's own JWT (forwarded via the Authorization header --
// supabase-js's functions.invoke() attaches the current session's access
// token automatically once setSession() has run) is verified via a real
// Supabase Auth call (auth.getUser()), not trusted from any client-supplied
// id -- there is no id in the request body at all. The resolved,
// server-verified user id is what the UPDATE is explicitly scoped to
// (.eq('id', callerId)), not left to RLS alone to catch: this uses the
// anon-key client (not service-role), so profiles_owner_only RLS still
// applies underneath as defense-in-depth, but the explicit filter means
// this can't silently become an any-row update if RLS were ever
// misconfigured or changed later.
//
// Deployed to project wrexmksxphqkanrzzvcd (verify_jwt: true).

import { createClient } from '@supabase/supabase-js'
import { validateDisplayName } from '../_shared/validate-display-name.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// Same allowlist secret and loopback-dev pattern as create-account /
// verify-move-sequence -- identical CORS posture across all three
// functions.
const ALLOWED_ORIGINS_ENV = 'ALLOWED_ORIGINS'
const LOCALHOST_ORIGIN_PATTERN = /^http:\/\/localhost:\d+$/

function buildCorsHeaders(req: Request): Record<string, string> {
  const allowedOrigins = (Deno.env.get(ALLOWED_ORIGINS_ENV) ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  }

  const requestOrigin = req.headers.get('origin')
  if (requestOrigin && (allowedOrigins.includes(requestOrigin) || LOCALHOST_ORIGIN_PATTERN.test(requestOrigin))) {
    headers['Access-Control-Allow-Origin'] = requestOrigin
  }

  return headers
}

Deno.serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req)

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  // Everything below is wrapped in try/catch so an uncaught exception (a
  // transient network-level failure inside an awaited supabase-js call)
  // still exits through jsonResponse() and carries corsHeaders -- same
  // fix applied to create-account/verify-move-sequence last session, built
  // in here from the start rather than retrofitted.
  try {
    let displayNameRaw: unknown
    try {
      const body = await req.json()
      displayNameRaw = body.displayName
    } catch {
      return jsonResponse({ error: 'invalid request body -- expected { displayName: string | null }' }, 400)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'not authenticated' }, 401)
    }

    // Anon-key client carrying the caller's own JWT -- auth.getUser() below
    // verifies it server-side and resolves the real caller identity. Not
    // service-role: RLS (profiles_owner_only) applies to every call this
    // client makes, on top of the explicit .eq('id', callerId) filter used
    // for the update itself.
    const authed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: userData, error: userError } = await authed.auth.getUser()
    if (userError || !userData?.user) {
      return jsonResponse({ error: 'not authenticated' }, 401)
    }
    const callerId = userData.user.id

    const validation = validateDisplayName(displayNameRaw)
    if (!validation.ok) {
      return jsonResponse({ error: validation.error }, 400)
    }

    const { data: updated, error: updateError } = await authed
      .from('profiles')
      .update({ display_name: validation.value })
      .eq('id', callerId)
      .select('display_name')
      .single()

    if (updateError) {
      return jsonResponse({ error: 'update failed' }, 500)
    }

    return jsonResponse({ displayName: updated.display_name }, 200)
  } catch (err) {
    console.error('unhandled exception in update-profile:', err)
    return jsonResponse({ error: 'internal error' }, 500)
  }
})
