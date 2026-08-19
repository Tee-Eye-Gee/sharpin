// supabase/functions/verify-move-sequence/index.ts
//
// Hybrid verification, server-side confirmation step (spec §3, item 2):
// receives a hash of the player's 4-move gesture, looks it up against
// profiles.move_sequence_hash using the service-role client (bypasses RLS
// -- deliberately; see the RLS migration's design note and this repo's
// build-stage-2 report for why profiles has no anon-readable policy), and
// on a match mints a real Supabase session for that profile.
//
// Never logs or persists the raw move sequence: only a hash arrives here,
// and only the match/no-match result (plus, on match, a session) leaves.
//
// This is the one intentionally pre-auth, publicly-callable endpoint in the
// system, so it also rate-limits by caller IP (see RATE_LIMIT_* below and
// the build-stage-2-revision report) before doing anything else.
//
// NOT DEPLOYED. Written for review only -- see build-stage-2 (+ revision) report.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Sliding-window IP throttle. Named constants, not inline magic numbers, so
// they're easy to retune later without hunting through the request logic.
const RATE_LIMIT_MAX_ATTEMPTS = 10
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

// Comma-separated allowlist, e.g. "https://sharpin.app,https://sharpin-git-main-tiggs.vercel.app".
// NOT SET YET -- this repo has no vercel.json and no reference anywhere to
// a production or preview URL (confirmed by grep during the Stage 2
// revision pass), so there was nothing to read the real value from and
// nothing safe to guess. This MUST be set via `supabase secrets set
// ALLOWED_ORIGINS=...` before deployment (Stage 3), or every browser
// caller will be CORS-blocked (see buildCorsHeaders -- an unmatched/absent
// Origin gets no Access-Control-Allow-Origin header at all, failing closed
// rather than falling back to "*").
const ALLOWED_ORIGINS_ENV = 'ALLOWED_ORIGINS'

function buildCorsHeaders(req: Request): Record<string, string> {
  const allowedOrigins = (Deno.env.get(ALLOWED_ORIGINS_ENV) ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    // Response varies by Origin -- relevant to any cache/CDN in front of this.
    Vary: 'Origin',
  }

  const requestOrigin = req.headers.get('origin')
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin
  }
  // No match (or no Origin header at all, e.g. a non-browser caller) ->
  // deliberately no Access-Control-Allow-Origin header. Browsers then block
  // the response client-side. This fails closed instead of the previous
  // '*' -- an unconfigured ALLOWED_ORIGINS means nothing gets through, not
  // everything.

  return headers
}

// x-forwarded-for is the current documented way to read the caller's IP in
// a Supabase Edge Function; Supabase's edge infra populates it. It can be a
// comma-separated proxy chain -- the first entry is the original client.
// Known caveat (Supabase's own docs/discussions): this header is not
// guaranteed to always be present. When it's missing, every such caller
// shares one 'unknown' bucket rather than skipping the throttle entirely --
// fails toward "some legitimate callers might get bucketed together under
// heavy load" rather than "rate limiting silently does nothing."
function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (!xff) return 'unknown'
  return xff.split(',')[0].trim() || 'unknown'
}

// Deterministic, non-deliverable placeholder address used only as the
// lookup key for admin.generateLink()'s magiclink flow -- never sent
// anywhere, never real mail (see report's "session-minting approach"
// section for why generateLink+verifyOtp was chosen over hand-signing a
// custom JWT).
//
// DEPENDENCY THIS CREATES FOR STAGE 3: whatever flow first creates a
// profiles row must also call
//   admin.auth.admin.updateUserById(profileId, { email: syntheticEmailFor(profileId), email_confirm: true })
// on that same auth.users row at creation time. If that's skipped,
// generateLink() below will silently CREATE A NEW, unrelated auth user
// (generateLink's magiclink type creates a user if the email doesn't
// already resolve to one) instead of resolving to the existing matched
// profile. The id-mismatch guard near the end of this function turns that
// failure mode into an explicit error instead of a silently wrong session,
// but it can't fix a missing Stage-3 wiring step -- flagging this loudly so
// it isn't lost before Stage 3 starts.
function syntheticEmailFor(profileId: string): string {
  return `${profileId}@auth.sharpin.internal`
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

  let moveSequenceHash: string
  try {
    const body = await req.json()
    if (typeof body.moveSequenceHash !== 'string' || body.moveSequenceHash.length === 0) {
      throw new Error('missing moveSequenceHash')
    }
    moveSequenceHash = body.moveSequenceHash
  } catch {
    return jsonResponse({ error: 'invalid request body -- expected { moveSequenceHash: string }' }, 400)
  }

  // Service-role client: bypasses RLS by design (service_role carries
  // BYPASSRLS). This is the only thing in the system allowed to read
  // across all profiles rows (and to read/write verify_attempts, which has
  // no policies at all -- see that migration), which is exactly what's
  // needed here: the caller isn't authenticated as any particular profile
  // yet.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- Rate limit: every call counts, match or not, before any hash work happens ---
  const clientIp = getClientIp(req)
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()

  const { count: recentAttempts, error: countError } = await admin
    .from('verify_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', clientIp)
    .gte('attempted_at', windowStart)

  if (countError) {
    // Fail closed: if the throttle itself can't be checked, don't proceed
    // as though it passed.
    return jsonResponse({ error: 'rate limit check failed' }, 500)
  }

  if ((recentAttempts ?? 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
    // Deliberately does NOT insert a verify_attempts row here -- this call
    // never reaches the hash lookup, so it shouldn't count as a "real"
    // attempt either. Rows already in the window are what's enforcing the
    // block; not adding more here keeps this a genuine sliding window
    // (capacity frees up as old rows age out) instead of a counter an
    // attacker can push further out just by continuing to hammer it.
    return jsonResponse({ error: 'too many attempts, try again later' }, 429)
  }

  const { error: recordError } = await admin.from('verify_attempts').insert({ ip_address: clientIp })

  if (recordError) {
    // Fail closed here too: if this attempt can't be recorded, don't let it
    // slip through uncounted.
    return jsonResponse({ error: 'rate limit check failed' }, 500)
  }

  // --- Existing hash lookup logic, unchanged below this point ---

  // Only the hash is ever compared. This is the only query in this
  // function that touches move_sequence_hash, and its result (found or
  // not) is the only thing that gets logged implicitly via the response --
  // nothing here writes the raw sequence or the hash to any log.
  const { data: profile, error: lookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('move_sequence_hash', moveSequenceHash)
    .maybeSingle()

  if (lookupError) {
    return jsonResponse({ error: 'lookup failed' }, 500)
  }

  if (!profile) {
    return jsonResponse({ match: false }, 200)
  }

  const email = syntheticEmailFor(profile.id)

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })

  if (linkError || !linkData?.properties?.hashed_token) {
    return jsonResponse({ error: 'session mint failed' }, 500)
  }

  const { data: sessionData, error: verifyError } = await admin.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  })

  if (verifyError || !sessionData?.session) {
    return jsonResponse({ error: 'session mint failed' }, 500)
  }

  // Safety check: see the syntheticEmailFor() comment above. Refuse rather
  // than hand back a session for the wrong user.
  if (sessionData.session.user.id !== profile.id) {
    return jsonResponse(
      { error: 'session identity mismatch -- profile not provisioned correctly, refusing to return a session' },
      500,
    )
  }

  return jsonResponse(
    {
      match: true,
      session: {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
      },
    },
    200,
  )
})
