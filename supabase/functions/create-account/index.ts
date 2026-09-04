// supabase/functions/create-account/index.ts
//
// Create Account server operation (spec §5a). The only place a `profiles`
// row (and its backing auth.users row) is ever created -- Login/
// verify-move-sequence only ever matches existing rows and must stay that
// way (spec §5, locked decision: account creation is never a fallback from
// a failed login).
//
// Operation order (spec §5a, final):
//   1. Collision check: incoming move-sequence hash against
//      profiles.move_sequence_hash (UNIQUE).
//   2. admin.createUser({ id, email: syntheticEmailFor(id), email_confirm: true })
//      -- single call, synthetic email set at creation. `id` is generated
//      here (crypto.randomUUID()) and passed in explicitly, rather than
//      taken from the createUser result, because profiles.id has a FK to
//      auth.users.id (see 20260819140000_init_schema.sql) and
//      syntheticEmailFor(id) needs the id *before* the call that would
//      otherwise generate one. supabase-js's AdminUserAttributes.id exists
//      exactly to "overwrite the default id set for the user" for this
//      kind of bring-your-own-id flow (confirmed against
//      @supabase/auth-js's shipped types, not assumed).
//   3. Insert `profiles` row keyed to that same id.
//   4. Mint session via ../_shared/mint-session.ts (same generateLink+
//      verifyOtp pattern as Login).
//   5. Return the session to the client.
//
// This is one of two intentionally pre-auth, publicly-callable endpoints in
// the system (the other is verify-move-sequence), so it rate-limits by
// caller IP before doing anything else -- see RATE_LIMIT_* below. It has
// its own throttle table (create_account_attempts), deliberately separate
// from verify-move-sequence's verify_attempts: different abuse profile
// (write/account-flooding vs. read/guess), different tuning, and this way
// tightening one throttle can never accidentally affect the other's
// already-live query. See the Stage 3 build report for the full reasoning.
//
// Deployed to project wrexmksxphqkanrzzvcd (verify_jwt: true) -- called
// pre-login, so the client's anon-key bearer (auto-attached by
// supabase.functions.invoke()) satisfies the gateway's JWT check without
// requiring an existing user session.

import { createClient } from '@supabase/supabase-js'
import { mintSessionForProfile, syntheticEmailFor } from '../_shared/mint-session.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Stricter than verify-move-sequence's 10/15min: legitimate users create an
// account once, not repeatedly, so there's no legitimate-use reason to
// allow anywhere near verify-move-sequence's login-retry volume here.
const RATE_LIMIT_MAX_ATTEMPTS = 3
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

// Same allowlist secret as verify-move-sequence -- set via
// `supabase secrets set ALLOWED_ORIGINS=...`. Fails closed: an unmatched or
// absent Origin gets no Access-Control-Allow-Origin header at all.
const ALLOWED_ORIGINS_ENV = 'ALLOWED_ORIGINS'

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
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin
  }

  return headers
}

// Same caveats as verify-move-sequence's getClientIp: x-forwarded-for isn't
// guaranteed present; missing callers share one 'unknown' bucket rather
// than skipping the throttle.
function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (!xff) return 'unknown'
  return xff.split(',')[0].trim() || 'unknown'
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

  // Service-role client: bypasses RLS by design, and is the only role
  // allowed to call admin.createUser / admin.createUser with a caller-set
  // id, or to touch create_account_attempts (no policies -- service-role
  // only, same posture as verify_attempts).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- Rate limit: every call counts, collision or not, before any write happens ---
  const clientIp = getClientIp(req)
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()

  const { count: recentAttempts, error: countError } = await admin
    .from('create_account_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', clientIp)
    .gte('attempted_at', windowStart)

  if (countError) {
    // Fail closed toward the *rate-limit* response, not a bare 500: the
    // count-then-insert pair below has no transaction/lock between its two
    // round trips, so two genuinely concurrent same-IP requests can each
    // hit a transient failure here (confirmed live -- see Stage 3 build
    // report). "Can't verify you're under the limit" and "you're over the
    // limit" both mean the same thing to the caller: try again later. A
    // bare 500 would leak that this is an internal-error path rather than
    // an ordinary rate-limit condition, for no benefit to a legitimate
    // client.
    return jsonResponse({ error: 'too many attempts, try again later' }, 429)
  }

  if ((recentAttempts ?? 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
    // Deliberately does NOT insert a create_account_attempts row here --
    // this call never reaches the collision check, so it shouldn't count
    // as a "real" attempt either. Same reasoning as verify-move-sequence's
    // equivalent branch: keeps this a genuine sliding window.
    return jsonResponse({ error: 'too many attempts, try again later' }, 429)
  }

  const { error: recordError } = await admin.from('create_account_attempts').insert({ ip_address: clientIp })

  if (recordError) {
    // Same reasoning as the countError branch above: fail toward 429, not
    // 500. We already know this request was under the limit as of the
    // count above -- if recording the attempt itself fails (again, most
    // likely two concurrent requests contending on the same connection),
    // don't let it slip through uncounted, but don't expose that as a raw
    // server error either.
    return jsonResponse({ error: 'too many attempts, try again later' }, 429)
  }

  // --- Step 1: collision check ---
  // App-level pre-check for a clean error message. profiles.move_sequence_hash
  // is also UNIQUE at the DB level (see 20260819140000_init_schema.sql), which
  // is the real backstop against a same-hash race between two concurrent
  // create-account calls -- see the insert step below.
  const { data: existing, error: collisionCheckError } = await admin
    .from('profiles')
    .select('id')
    .eq('move_sequence_hash', moveSequenceHash)
    .maybeSingle()

  if (collisionCheckError) {
    return jsonResponse({ error: 'collision check failed' }, 500)
  }

  if (existing) {
    return jsonResponse({ error: 'that sequence is already in use -- choose another' }, 409)
  }

  // --- Step 2: create the auth user, id generated up front ---
  // profiles.id has a FK to auth.users.id, and syntheticEmailFor(id) needs
  // the id before this call -- so the id is ours to generate, not taken
  // from the createUser result. See the module header for why this is safe.
  const newProfileId = crypto.randomUUID()

  const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
    id: newProfileId,
    email: syntheticEmailFor(newProfileId),
    email_confirm: true,
  })

  if (createUserError || !createdUser?.user) {
    return jsonResponse({ error: 'account creation failed' }, 500)
  }

  // Defensive check, same posture as verify-move-sequence's id-mismatch
  // guard: refuse rather than proceed on an inconsistency that shouldn't be
  // possible, instead of silently trusting our own generated value.
  if (createdUser.user.id !== newProfileId) {
    return jsonResponse(
      { error: 'account creation returned an unexpected id -- refusing to proceed' },
      500,
    )
  }

  // --- Step 3: insert the profiles row ---
  const { error: profileInsertError } = await admin
    .from('profiles')
    .insert({ id: newProfileId, move_sequence_hash: moveSequenceHash })

  if (profileInsertError) {
    // Roll back the just-created auth user so a failed create-account call
    // never leaves an orphaned auth.users row with no matching profile.
    // Best-effort: the profiles insert itself is what actually failed (e.g.
    // the UNIQUE-constraint race noted above), so failure here is reported
    // via the original error, not this cleanup step.
    await admin.auth.admin.deleteUser(newProfileId)

    // A unique-constraint violation on move_sequence_hash at this point
    // means a concurrent request won the collision-check race -- same
    // client-facing error as the pre-check above, not a generic 500.
    if (profileInsertError.code === '23505') {
      return jsonResponse({ error: 'that sequence is already in use -- choose another' }, 409)
    }
    return jsonResponse({ error: 'account creation failed' }, 500)
  }

  // --- Step 4: mint session ---
  const minted = await mintSessionForProfile(admin, newProfileId)

  if (!minted.ok) {
    return jsonResponse({ error: minted.error }, 500)
  }

  // --- Step 5: return session ---
  return jsonResponse({ session: minted.session }, 200)
})
