// supabase/functions/_shared/mint-session.ts
//
// Session-minting helper shared between verify-move-sequence (Login) and
// create-account (spec §5a). Both flows resolve to a known profiles.id and
// need a real Supabase session for that identity's synthetic auth.users
// row -- this is the only place the generateLink(magiclink) + verifyOtp()
// pairing lives, extracted out of verify-move-sequence during the Stage 3
// build so create-account doesn't duplicate it.
//
// Callers are responsible for ensuring the target auth.users row already
// has its synthetic email set (email_confirm: true) *before* calling this
// -- otherwise generateLink's magiclink type will silently create a new,
// unrelated auth user instead of resolving to the intended profile.
// verify-move-sequence relies on that already having been done at account
// creation (create-account's admin.createUser call sets it atomically);
// create-account itself satisfies the precondition by construction, one
// step before calling this helper.

import type { SupabaseClient } from '@supabase/supabase-js'

export function syntheticEmailFor(profileId: string): string {
  return `${profileId}@auth.sharpin.internal`
}

export type MintedSession = {
  access_token: string
  refresh_token: string
}

export type MintSessionResult =
  | { ok: true; session: MintedSession }
  | { ok: false; error: string }

/**
 * Mints a real Supabase session for the given profile id via
 * generateLink(magiclink) + verifyOtp(). Verifies the minted session's user
 * id matches profileId exactly before returning it -- refuses rather than
 * handing back a session for the wrong user (see module note above).
 */
export async function mintSessionForProfile(
  admin: SupabaseClient,
  profileId: string,
): Promise<MintSessionResult> {
  const email = syntheticEmailFor(profileId)

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })

  if (linkError || !linkData?.properties?.hashed_token) {
    return { ok: false, error: 'session mint failed' }
  }

  const { data: sessionData, error: verifyError } = await admin.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  })

  if (verifyError || !sessionData?.session) {
    return { ok: false, error: 'session mint failed' }
  }

  if (sessionData.session.user.id !== profileId) {
    return {
      ok: false,
      error: 'session identity mismatch -- profile not provisioned correctly, refusing to return a session',
    }
  }

  return {
    ok: true,
    session: {
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
    },
  }
}
