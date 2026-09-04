# Sharpin — Spec: Account Auth & Cross-Device Sync

Status: Scoped, ready for investigation prompt
Session: August 18, 2026
Backlog item: #1 — Cross-device profile sync

---

## 1. Goal

Replace local-only IndexedDB storage with a Supabase-backed account system that:
- Identifies "Tiggs" via a permanent 4-move chess gesture (not a password)
- Syncs puzzle history, rating, streaks, and hint-state across devices
- Supports guests (no account) playing without friction
- Reserves a separate, unrelated entry point for a future admin panel (backlog #5)
- Costs $0 (Supabase free tier + Vercel)

This is architecture + auth + sync. It does NOT include the admin panel's actual contents (backlog #5, deferred) or Personal Analytics UI (backlog #2, sequenced right after this).

---

## 2. Identity Model

- Real Supabase Auth identity (anonymous auth, upgradeable to email/magic-link later if multi-user ever happens). This is the actual account. The 4-move sequence is the **permanent, real credential** bound to that identity — not a convenience shortcut over something else.
- One secret move-sequence per account row (namespaced per-user, not global) — required so a second account, if it ever exists, cannot collide with or be confused for the first.
- Accepted risk, explicitly logged: a 4-move sequence has lower practical entropy than a real password, since people gravitate to memorable patterns. Acceptable for current single-user scope. If this becomes a concern later, the fix is additive (e.g. extend to 5 moves, add optional PIN fallback) — not a rebuild.

## 3. Verification — Hybrid Model

1. **Local match (client-side):** immediate UI feedback — board recognizes the sequence, feels instant, no network round-trip needed to react.
2. **Server-side confirmation (Supabase Edge Function):** before any real data is pulled or written, the client sends the move sequence (or a hash of it) to an Edge Function, which compares it against the stored hash for that account row and returns a valid Supabase session/token.
3. Only after step 2 succeeds does the client fetch account data (rating, streaks, needs-work, etc.) or gain write access.

This means a leaked Supabase project URL alone is insufficient to read/write someone's data — the Edge Function + RLS (below) are the real boundary, not client-side JS.

## 4. Data Model (Supabase / Postgres)

Finalized against investigation findings (Aug 18) — corrects the original draft's mismatches with the actual v2 IndexedDB schema.

- `profiles`
  - `id` (uuid, = auth.uid())
  - `move_sequence_hash` (text)
  - `created_at`
- `puzzle_attempts` (per-record LWW target)
  - `id` (uuid, generated at write/migration time — NEVER reused from local IndexedDB's autoIncrement int, which is only unique within one browser and would collide across devices on migration)
  - `profile_id` (FK → profiles.id)
  - `puzzle_id`
  - `themes` (array)
  - `solved` (boolean — mirrors local schema directly; no enum translation layer)
  - `hint_used` (boolean — mirrors proposed local v3 field directly)
  - `rating_delta`
  - `time_taken_ms`
  - `attempted_at` (client-meaningful timestamp — when the user actually attempted the puzzle, sourced from local `at`)
  - `updated_at` (server-set, `now()` — this is the LWW sync-conflict timestamp ONLY; never read by UI, never conflated with `attempted_at`)
- `theme_stats` (NEW — added per investigation; original draft omitted this despite §5 requiring it for "needs-work areas")
  - `profile_id` (FK)
  - `theme` (text)
  - `attempts` (int)
  - `solved` (int)
  - `updated_at` (server-set)
- `profile_stats` (rating, streak, aggregate fields)
  - `profile_id` (FK)
  - `rating`
  - `current_streak`
  - `best_streak` (added per investigation — coach.js's overall-rate calc needs it)
  - `total_solved` (added per investigation)
  - `total_failed` (added per investigation)
  - `updated_at` (server-set)
- `preferences` (NEW — cross-device sync, per Tiggs's explicit decision this round)
  - `profile_id` (FK)
  - `app_mode` (dark/light/null)
  - `board_theme`
  - `input_mode` (drag/tap)
  - `updated_at` (server-set)

**RLS:** every table keyed to `profile_id = auth.uid()`, enforced at the database level — not just app logic.

**Conflict resolution:** per-record LWW using `updated_at`, set by Postgres (`now()`) on write — never a client-supplied timestamp. This means individual puzzle attempts sync independently; a solve recorded on mobile at 12:37 and a different solve recorded on web at 1:42 both persist, rather than one snapshot overwriting the other. Preferences also sync via per-record LWW on the single `preferences` row per profile — the more recent device-side change wins.

**v3 local schema note:** old `attempts` rows written before the `hintUsed` field existed will read back `undefined` for it. Default at read time (`hintUsed ?? false`), mirroring the existing `getPreferences()` spread-default pattern already used in this codebase — no upgrade-time backfill cursor needed.

## 5. App Flow

**Launch routing (every app boot):**
- Device boot check: valid local Supabase session on this device → skip any screen entirely, auto-resume directly into gameplay (account data is already local/cached from the last sync — see §6 for sync triggers; boot does not block on a synchronous re-fetch).
- No valid session → show a 3-tier launch screen:
  - **Play as Guest** (primary) → straight into puzzles, guest IndexedDB state, no account.
  - **Create Account** (secondary) → new profile creation; see §5a.
  - **Login** (tertiary, link-styled — visually subordinate to the two primary actions) → 4-move gesture entry against an existing account.

**Login / 4-move gesture entry:**
- Reached only from the "Login" tertiary link on the launch screen — by definition only shown when there is no valid persisted session. Every gesture entry therefore performs full hybrid verification per §3; there is no separate "known device, skip re-verification" branch. (That case — a device that already holds a valid session — is handled entirely by the boot check above, which skips the launch screen altogether rather than showing it and then short-circuiting the gesture. This supersedes the old spec's "known device with valid persisted session → gesture resumes/re-confirms" branch, which no longer has a code path that would reach it.)
- `verify-move-sequence` checks the submitted hash against **existing** `move_sequence_hash` rows only. It has no create path today and must not gain one.
- **Locked decision: profile creation is never a fallback from a failed Login/verify-move-sequence attempt.** A no-match result is a plain login failure — it returns the user to the launch screen (or an inline "not recognized" state on it). Creating an account, if the user wants one, always requires the separate, explicit Create Account action described in §5a.
- On success → pulls account data (rating, streak, needs-work areas) from Supabase.

**Login visibility constraint:**
- The Login control (tertiary link) is exposed only on the launch screen — i.e., between puzzles / before a session starts. It is never exposed anywhere in the mid-puzzle UI.
- No guard exists, or is planned, to protect an in-flight attempt commit from a mid-puzzle identity change (`usePuzzleEngine.js` investigation finding: puzzle-instance state carries no identity of its own — it resolves whatever the storage layer returns at commit time, whether that's still the guest profile or a just-authenticated one). Keeping Login unreachable during an active puzzle **is** the entire mitigation for this risk, not a UI convenience layered on top of a code-level guard.

**Logout:**
- Reverts UI to standard opening board, standard starting rating
- Underlying guest/local IndexedDB state (if any existed before or during this session) persists untouched — not wiped
- Session token cleared for this device
- Returns to the 3-tier launch screen (Guest / Create Account / Login) described above — the screen only reappears after this explicit logout, or whenever the boot check finds no valid session

**Guest → account migration:**
- Triggered any time a device transitions into a logged-in state (fresh install with pre-existing local history and a fresh Create Account, OR guest-play history on this device followed by later Login to an existing account) and finds local IndexedDB data not yet tied to an account.
- User is prompted to choose explicitly — never auto-resolved:
  - **Merge** — adopt the local history into the account.
  - **Discard** — leave the account as-is; drop the local guest history.

**Admin panel entry (separate, unrelated):**
- Triple-tap Sharpin logo → password-gated screen (placeholder auth for now, modeled on Fluency's approach — real spec pulled later)
- Entirely separate from the 4-move identity system
- Panel contents out of scope for this spec (backlog #5)

## 5a. Create Account — Server Operation (NEW)

Status: this logic does not exist yet. Confirmed via investigation — the current `verify-move-sequence` Edge Function only ever performs a lookup against existing `profiles` rows (`.maybeSingle()` on `move_sequence_hash`) and returns `{ match: false }` on no match; it has no insert/create path. Create Account is a new, separate Edge Function (see below), not an added branch inside the existing lookup.

**Identity creation is entirely server-side.** The Create Account Edge Function is the only thing that creates the underlying `auth.users` row — there is no client-side `signInAnonymously()` call and no separate update-after-create step. A single `admin.createUser({ email: syntheticEmailFor(newProfileId), email_confirm: true })` call creates the auth user with its synthetic email already set at creation time. This is what makes the email-set atomic: there is no second step, so there is no window where a `profiles` row (or an auth user) could exist without its synthetic email — the exact gap `verify-move-sequence`'s own code comments flag as dangerous (an unset synthetic email would let a later Login's `generateLink()` magiclink call silently create a new, unrelated auth user instead of resolving to the real profile).

**Final operation order:**
1. **Collision check** — the newly-chosen 4-move sequence's hash is checked against `profiles.move_sequence_hash` (already `UNIQUE`) before doing anything else, so a collision surfaces as a clear "that sequence is already in use, choose another" response rather than a raw DB unique-constraint error, and before any auth user is created for a request that's going to fail anyway.
2. **`admin.createUser({ email: syntheticEmailFor(newProfileId), email_confirm: true })`** — single call; creates the `auth.users` row with the synthetic email and confirmation already set.
3. **Insert `profiles` row** — `id` = the new user's id (from step 2), `move_sequence_hash` = the new hash, `created_at` server-set (existing trigger).
4. **Mint session** via the shared session-mint helper (same `generateLink()` + `verifyOtp()` pattern `verify-move-sequence` uses for Login).
5. **Return session** to the client.

**Separate Edge Function from `verify-move-sequence`, with shared session-minting code.** Create Account and Login/verify-move-sequence are two distinct Edge Functions, each with its own rate-limit/throttle policy — they have different abuse profiles (verify-move-sequence is a read/guess target; Create Account is a write/account-flooding target) and sharing one limiter would either under-throttle one or over-throttle the other. The `generateLink()` + `verifyOtp()` session-minting logic both functions need is factored into one small shared Deno module imported by both, so that logic isn't duplicated even though the two functions themselves stay separate.

**File layout:** confirmed against the existing Stage 2 layout (`supabase/functions/verify-move-sequence/{deno.json,index.ts}`) — this fits cleanly with no changes needed elsewhere:
- `supabase/functions/create-account/{deno.json,index.ts}` — new function, sibling to `verify-move-sequence`, same per-function directory convention already in use.
- `supabase/functions/_shared/mint-session.ts` — the shared session-mint helper. An underscore-prefixed directory under `supabase/functions/` is Supabase's standard convention for code shared across functions (excluded from individual function deployment); no `_shared/` directory exists yet in this repo, so this introduces the convention rather than colliding with anything.

## 6. Sync Triggers

Login/logout-boundary sync (pull on login, push on logout/background), favoring free-tier efficiency over continuous real-time sync. Exact trigger granularity (e.g. also sync after each puzzle completion vs. batch at session end) to be finalized in investigation against Supabase free-tier request limits.

## 7. Sequencing

Per Tiggs's explicit call: the schema v3 migration needed for Personal Analytics (backlog #2, hint-used-state persistence) happens **before** this sync work ships, so sync is built against the final schema rather than needing to be touched twice.

## 8. Accepted Risks (logged, not blocking)

- 4-move sequence has lower real-world entropy than a password — accepted for current single-user scope.
- Supabase free-tier projects auto-pause after ~1 week of inactivity — accepted, may cause a cold-start delay on first open after a gap.
- Per-record LWW does not merge conflicting edits to the *same* record made near-simultaneously on two devices — last server-timestamped write to that specific record wins. Given actual usage pattern (sequential device use, not simultaneous), risk is low but not zero.
- **verify-move-sequence and create-account rate limiting is IP-based; whether X-Forwarded-For is actually spoofable on this deployment is unconfirmed, not confirmed either way.** A per-IP throttle was added to both (verify-move-sequence: 10 attempts / 15 min via `verify_attempts`; create-account: 3 attempts / 60 min via `create_account_attempts`) as a deterrent against casual/naive automated abuse. Both functions' `getClientIp()` (identical logic — `create-account/index.ts:80-84`, same in `verify-move-sequence`) reads only the `X-Forwarded-For` header, with no fallback to any other header; the application code itself does nothing unusual here. This note previously stated, based on general Supabase community reports, that `X-Forwarded-For` is confirmed spoofable on this platform. Live testing during the Stage 3 build contradicts that for this specific deployment: a spoofed `X-Forwarded-For` value sent to create-account had no effect — both requests were logged under the real source IP regardless of what was sent. The underlying mechanism is **not confirmed** — there is no visibility from this repo into Supabase's edge/gateway layer, so this is an observed result from one live test, not a verified platform guarantee. Something upstream of the function (outside this repo) appears to be overwriting or sanitizing the header before either function sees it, but that is inference from behavior, not something checked against Supabase's own documentation or support. Practical implication: the rate limiter may be a firmer boundary against IP spoofing than originally assumed here, but this should not be treated as a hard security guarantee without further confirmation (e.g. directly from Supabase's docs/support, or more extensive testing across multiple spoofed values and conditions) — for planning purposes, continue treating it as NOT a hard security boundary. It does not compensate for the entropy risk above regardless of how the spoofing question resolves. Accepted because: (a) no dollar cost is possible on the free tier if abused — Supabase's Fair Use Policy returns 402 project-wide rather than billing overages, so worst case is a self-healing outage (resets next billing cycle), not a permanent cost; (b) the project's Supabase URL is not publicly discoverable/indexed, only present in the deployed JS bundle, making opportunistic/scanner-driven abuse unlikely; (c) RLS and hashing still hold even if the rate limit is bypassed — bypassing it only re-exposes the entropy risk already logged above, it doesn't create a new data-exposure path. Revisit if there's ever concrete reason to believe the app is being specifically targeted, or once the platform mechanism itself is actually confirmed one way or the other.

## 8a. CLAUDE.md Update Required

Re-checked against the current file during the Stage 3 investigation pass (this revision) — the specific staleness logged here previously has already been partly fixed and is now inaccurate as written. What's actually true as of this revision:

- **Already resolved, no longer an issue:** CLAUDE.md's "Current task" pointer already points at this spec (not Sharpin_Spec_ColorScheme.md), and the tech-stack section no longer says "no auth, no cross-device sync" — it already acknowledges Supabase work is in progress.
- **Still wrong, needs fixing:**
  1. CLAUDE.md's Environment section states "No API keys, no `.env` file needed." This is false — a `.env` file exists in the repo root (correctly gitignored). Needs updating regardless of whether Stage 3 client code ends up reading from it directly.
  2. CLAUDE.md's tech-stack and current-task sections both describe Stage 1 of 3 as done and Stages 2-3 as "not built yet" / "not started." This undersells the actual state: Stage 2's migrations and the `verify-move-sequence` Edge Function are written and were previously reviewed and live-verified — investigation found Stage 2 is code-complete, just not currently deployed to a live Supabase project (the prior project was deleted for a key-exposure incident and needs re-provisioning before anything can run live against it). CLAUDE.md should distinguish "code written and reviewed" from "deployed and live," rather than lumping Stage 2 in with "not started."

As before: this should land before or alongside the Stage 3 build prompt, not after. (Out of scope for this revision pass — this pass edits only this spec doc, not CLAUDE.md itself.)

## 9. Out of Scope (this spec)

- Admin panel contents/functionality (backlog #5)
- Personal Analytics UI (backlog #2) — only its required schema v3 migration is pulled forward
- Multi-user account creation UI (identity model supports it later; no UI built now)
- Placement quiz, difficulty setting, timed mode, offline PWA (unrelated backlog items)
