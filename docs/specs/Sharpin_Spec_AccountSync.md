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

**First launch (no account, no local history):**
- Standard board, standard starting rating
- Choice: "Login" or "Play Free"
- Play Free → straight into puzzles, guest IndexedDB state, no account
- Login → 4-move board

**4-move gesture entry:**
- New/unrecognized device → establishes session (full hybrid verification per §3)
- Known device with valid persisted session → gesture resumes/re-confirms, no new handshake needed
- On success → pulls account data (rating, streak, needs-work areas) from Supabase

**Return visits (any device, already logged in):**
- Auto-resume directly into the account session — no "Login or Play Free" screen shown again
- Choice screen only reappears after explicit logout

**Logout:**
- Reverts UI to standard opening board, standard starting rating
- Underlying guest/local IndexedDB state (if any existed before or during this session) persists untouched — not wiped
- Session token cleared for this device

**Guest → account migration:**
- Triggered any time a device transitions into a logged-in state (fresh install with pre-existing local history, OR guest-play history followed by later login) and finds local IndexedDB data not yet tied to an account
- User is offered to adopt that local history into the account (single migration path for both trigger cases)

**Admin panel entry (separate, unrelated):**
- Triple-tap Sharpin logo → password-gated screen (placeholder auth for now, modeled on Fluency's approach — real spec pulled later)
- Entirely separate from the 4-move identity system
- Panel contents out of scope for this spec (backlog #5)

## 6. Sync Triggers

Login/logout-boundary sync (pull on login, push on logout/background), favoring free-tier efficiency over continuous real-time sync. Exact trigger granularity (e.g. also sync after each puzzle completion vs. batch at session end) to be finalized in investigation against Supabase free-tier request limits.

## 7. Sequencing

Per Tiggs's explicit call: the schema v3 migration needed for Personal Analytics (backlog #2, hint-used-state persistence) happens **before** this sync work ships, so sync is built against the final schema rather than needing to be touched twice.

## 8. Accepted Risks (logged, not blocking)

- 4-move sequence has lower real-world entropy than a password — accepted for current single-user scope.
- Supabase free-tier projects auto-pause after ~1 week of inactivity — accepted, may cause a cold-start delay on first open after a gap.
- Per-record LWW does not merge conflicting edits to the *same* record made near-simultaneously on two devices — last server-timestamped write to that specific record wins. Given actual usage pattern (sequential device use, not simultaneous), risk is low but not zero.
- **verify-move-sequence rate limiting is IP-based and spoofable.** A per-IP throttle (10 attempts / 15 min, via a `verify_attempts` table) was added as a deterrent against casual/naive automated guessing. Confirmed via Supabase community reports that `X-Forwarded-For` is not reliably trustworthy on this platform — a deliberate attacker can set an arbitrary value per request and bypass the throttle entirely. This is NOT a hard security boundary, only a deterrent layer; it does not compensate for the entropy risk above. Accepted because: (a) no dollar cost is possible on the free tier if abused — Supabase's Fair Use Policy returns 402 project-wide rather than billing overages, so worst case is a self-healing outage (resets next billing cycle), not a permanent cost; (b) the project's Supabase URL is not publicly discoverable/indexed, only present in the deployed JS bundle, making opportunistic/scanner-driven abuse unlikely; (c) RLS and hashing still hold even if the rate limit is bypassed — bypassing it only re-exposes the entropy risk already logged above, it doesn't create a new data-exposure path. Revisit if there's ever concrete reason to believe the app is being specifically targeted.

## 8a. CLAUDE.md Update Required

Investigation flagged that CLAUDE.md's tech-stack section currently states "IndexedDB — local-only persistence, no auth, no cross-device sync" and "no backend, no API keys, zero network calls on solve/fail" — directly contradicted by this spec. CLAUDE.md's "Current task" pointer also still references Sharpin_Spec_ColorScheme.md. As part of this initiative's rollout (before or alongside the build prompt, not after): confirm the color-scheme task is actually complete, then update CLAUDE.md's tech-stack description and current-task pointer to reflect Supabase/auth/sync as the active architecture.

## 9. Out of Scope (this spec)

- Admin panel contents/functionality (backlog #5)
- Personal Analytics UI (backlog #2) — only its required schema v3 migration is pulled forward
- Multi-user account creation UI (identity model supports it later; no UI built now)
- Placement quiz, difficulty setting, timed mode, offline PWA (unrelated backlog items)
