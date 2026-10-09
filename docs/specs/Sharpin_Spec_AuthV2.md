# Sharpin Spec: Auth V2 (Email + Move-Sequence Password)

**Status:** v2.  Scope locked 2026-10-09.  Investigation complete 2026-10-09.  Ready for build after #1d (expanded).
**Owner:** Tiggs (product decisions) · Theo (spec, prompts) · Theo Code (investigation, build)
**Release target:** Family-only first cohort.  No fixed date.  Release happens when all 12 acceptance criteria pass (§8), followed by one week of Tiggs's own use on two devices.

---

## 1. Goal

Release account authentication to production so real users can: create an account, merge guest data, log out, log back in with their data intact, and recover or change their credential.

## 2. Why the current model is being replaced

The 2026-10-08 read-only investigation found that the 4-move sequence is the account's only credential, with no identifier:

- The client sends an unsalted SHA-256 of the sequence.  The server matches that hash directly, so a leaked hash works as a login.
- Sequences must be unique across all users, so signup's "already in use" (409) message reveals another user's working credential.
- Rate limiting is per IP only.  There is no per-account lockout, and every guess searches all accounts at once.
- A mis-entered sequence that matches another account silently logs into it (Finding B).
- No recovery or change path exists (Finding A, which is the same gap as #4).

All five trace back to the sequence acting as both identifier and secret.  Auth V2 separates them: email identifies the account, and the sequence is the password.

## 3. Locked decisions

| # | Decision |
|---|---|
| D1 | Email is required at signup. |
| D2 | Email confirmation is required before the account becomes active.  Guest data stays on the device until the user confirms. |
| D3 | The password is the lowercase hex SHA-256 of the 4 moves, joined in order with `\|`.  The user still draws the moves on the board.  Order matters.  Supabase Auth hashes the value again on the server (bcrypt).  Dashboard check: the "Required characters" setting must be off or limited to letters and digits. |
| D4 | Sequence uniqueness is dropped.  Two users may choose the same moves; email tells them apart. |
| D5 | After login, the UI shows "Signed in as [display name]", falling back to email when no name is set.  Display name stays optional and does not need to be unique. |
| D6 | Logout first flushes any unsynced attempts, then clears that account's local cache.  Guest data is untouched.  If anything is still unsynced, the user is warned (Cancel / "Log out anyway"). |
| D7 | Auth email is sent through Resend's custom SMTP from a subdomain of somewhatextemporaneous.com (interim; DNS managed at Squarespace).  Add a DMARC record (`p=none`).  The sender display name is "Sharpin."  The domain can be swapped later (e.g. a purchased Sharpin domain) with only DNS and SMTP config changes. |
| D8 | Tee_Eye_Gee is migrated in place: attach Tiggs's real email to the existing auth user, then set a new sequence through the password-reset flow (no shortcut).  Existing data is preserved.  TEST_FIXTURE_KEEP gets a controlled email and keeps its existing hash as its password. |
| D9 | Brute-force protection uses Supabase Auth's built-in rate limits.  The custom per-IP limiter is retired with the custom Edge Functions. |
| D10 | User-initiated account deletion is in scope.  The sequence is verified server-side before deletion. |
| D11 | A guest with local history who signs into an existing account is not merged.  Guest data stays under "guest."  Merge/Discard is offered only when a new account first signs in. |
| D12 | #1d is expanded: the profile and puzzle reload whenever the active user changes (login, logout, recovery), not only at boot.  This is a release prerequisite. |
| D13 | Lower the `/token` rate limit from 150 to 30 per 5 minutes.  No CAPTCHA for the family cohort. |
| D14 | Logout uses `signOut({ scope: 'local' })`, so other devices stay signed in. |
| D15 | After a sequence reset or change, all other sessions for that account are signed out. |
| D16 | Throwaway test accounts use plus-addressed Gmail (real confirmation flow) or dashboard auto-confirm (quick checks). |
| D17 | Email-existence leaks on the unconfirmed-account sign-in path are accepted for the family cohort.  Verify live; revisit before expanding. |

## 4. Credential rules (unchanged from V1 except where noted)

- Same board input as today: fixed starting position, any piece to any square, no legality check, promotion disabled.
- Exactly 4 moves.  Order matters.
- Client sends `sha256_hex(moves.join('|'))` as the password.  The raw sequence never leaves the device.
- **Changed:** no uniqueness check, so no "sequence already in use" message.

## 5. User flows

| Flow | Behavior |
|---|---|
| **Sign up** | Email + optional display name + draw 4 moves (confirm by drawing a second time).  `signUp` with the display name in `options.data`.  The screen always says "check your email."  The account is active once the link is clicked. |
| **Confirm / reset links** | Email templates link to the app with `token_hash` and `type`.  The app calls `verifyOtp` at boot, before `getSession()`, then strips the URL parameters.  Works in any browser, including in-app email browsers. |
| **Sign in** | Email + draw 4 moves → `signInWithPassword`.  On success: "Signed in as…".  On failure: a generic "Email or sequence not recognized" message. |
| **First sign-in of a new account** | Offer Merge / Discard if guest history exists (D11).  If `profiles.display_name` is empty and the signup metadata has a name, set it through `update-profile`. |
| **Forgot sequence** | Enter email → `resetPasswordForEmail` → link → recovery session.  The app must not treat a recovery session as a normal login.  It shows a "draw your new sequence twice" view outside LaunchOverlay → `updateUser({ password })` → sign out other sessions (D15) → signed in. |
| **Change sequence (#4)** | Settings → Account: draw the current sequence (checked with `signInWithPassword`), then the new one twice → `updateUser` → sign out other sessions. |
| **Logout** | Capture the user ID → flush attempts → sync preferences → re-check what's unsynced → warn if needed → `signOut({ scope: 'local' })` → delete that user's local records only → reload guest preferences. |
| **Delete account** | Settings → Account: draw the current sequence → `delete-account` Edge Function verifies it server-side, then deletes the user with the service role → client signs out locally and deletes the local records. |
| **Guest with history signs into an existing account** | No merge (D11).  Guest data stays under "guest." |
| **Rate limited** | A specific "Too many attempts, try again later" message on HTTP 429. |

## 6. Code and schema impact (confirmed by investigation)

- **Retire and undeploy:** `verify-move-sequence`, `create-account`, `_shared/mint-session`.
- **Keep:** `update-profile`, `_shared/validate-display-name`.
- **Replace with:** supabase-js `signUp`, `signInWithPassword`, `resetPasswordForEmail`, `verifyOtp`, `updateUser`.
- **Profile row creation:** a `security definer` trigger on `auth.users` that inserts `(id)` only, `on conflict do nothing`.
- **Schema (one migration):** drop `profiles.move_sequence_hash` and its unique constraint, drop `verify_attempts` and `create_account_attempts`, add the trigger.  The column drop and the trigger must ship together, after the V1 functions are undeployed.
- **New:** `delete-account` Edge Function.  A storage helper that deletes one user's local records.
- **Tests:** rewrite the mocks in `LaunchOverlay.migration.test.jsx`.
- **Config:** custom SMTP, Site URL, redirect allowlist (dev + prod), both email templates, email confirmation on, `/token` limit, password "Required characters" check.

## 7. Out of scope

- OAuth / Google sign-in.
- CAPTCHA.  Revisit if the cohort expands beyond family or sign-in failures look anomalous.
- Merging guest history into an existing account, including the combined-rating rule.  Separate backlog item.
- Privacy policy.  Deferred until the cohort expands beyond family.
- Free-tier keep-alive and backup jobs.  Separate backlog item, required before release.

## 8. Acceptance criteria

Each item below needs raw evidence inline (console output, IndexedDB dumps, decoded session IDs, Supabase query results), at both ~375px and ~1280px, in dev and then as a production smoke test.

1. Sign up → confirmation email arrives → confirm (including from a phone's in-app email browser) → signed in, with "Signed in as…" shown.
2. Wrong sequence for a valid email → rejected, and the session is unchanged.
3. Reversed-order sequence → rejected.
4. Two accounts with the same sequence → each signs into its own account.
5. Guest merge into a new account → data present after logout and re-login.
6. Guest with history signs into an existing account → the account's data and rating are unchanged; guest data is still present after logout; no rating is written against the wrong base (depends on #1d expanded).
7. Logout → that account's local records cleared; guest records intact; other devices stay signed in.
8. Forgot sequence → email → new sequence → sign in with the new one; the old one is rejected; other sessions signed out.
9. Change sequence → the new one works and the old one is rejected.
10. Delete account → server rows gone (cascade verified), local cache gone, signing in again fails.
11. Repeated failed logins → rate-limit message shown.
12. Tee_Eye_Gee migrated with all 23 attempts intact.

## 9. Kill switch

- If Supabase Auth cannot accept the board-drawn sequence as the password flow requires, stop and re-decide (fallback: magic-link-only login).  Investigation found no blocker.
- If custom SMTP cannot be run at $0 on acceptable terms, stop and decide explicitly before building.  Investigation found Resend's free tier sufficient.
- If expanded #1d cannot reliably reload state on user change, fall back to a full page reload after login, logout, and recovery.

## 10. Gate notes

- Any write to the production Supabase project (schema migration, undeploying functions, Auth config, the Tee_Eye_Gee and fixture migrations) must be flagged and approved before it runs.
- Build order: #1d (expanded) → schema / auth backend → client auth UI → logout and local-cache clearing → account deletion → data migration.  One commit per item; stats/scoring and visual changes each need explicit push sign-off.
