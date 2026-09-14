# Investigation: Guest-Merge Local Profile/ThemeStats Migration Gap (Backlog #1g, NEW, blocking)

Status: **Findings only — no code changes, no commits, no writes to Supabase (local or
production).** For review before scope is locked.
Date: 2026-09-14

Prerequisite reading (per the prompt, both reviewed before writing anything below): `CLAUDE.md`
(storage-partitioning section, theme/preferences-sync section, #1e/#1f entries) and
`scratch-migration-verify.mjs` (repo root, uncommitted, left in place as the live reproduction).

**Bottom line up front:** the bug is real, reproduced live against production Supabase twice
(two independent throwaway accounts), and root-caused precisely in the code. It is **not scoped to
Merge alone** — tracing the same missing mechanism shows it's equally reachable via an ordinary
Login on any device that doesn't already hold a local `profile`/`themeStats` record for that
identity (a second device, or a cleared/fresh browser profile on the first one). That reframes this
from "a Merge-specific defect" to "the client never actually implements the local-side half of
`profile_stats`/`theme_stats` sync the spec itself calls for" — this project's own prior
`storage-partitioning-investigation.md` came within one sentence of naming this exact gap in its
"second-device scenario" analysis and stopped short of it (§1 below). Treat with the severity
Tiggs specified: **blocking precondition, same standing as #1d** — see §4's explicit statement of
what it blocks.

---

## 1. Exact Failure Mechanics

### 1a. `migrateGuestDataToAccount` traced end to end (`LaunchOverlay.jsx:58-122`)

Write order, confirmed by direct read:

1. Pre-check: `existingRemoteAttempts` count against `puzzle_attempts` for the new `profile_id`
   (line 59-66) — decides whether this is a fresh migration or an already-migrated retry.
2. **If fresh** (line 68-106): reads local guest attempts (`getAllAttempts({identity:
   GUEST_IDENTITY})`), inserts them into remote `puzzle_attempts`, then calls
   `markAttemptsSynced(..., {identity: userId})` — this is the ONE call that also touches local
   IndexedDB: it reassigns each local attempt row's `ownerId` from `'guest'` to the new account id,
   in place, on the *same* `attempts` store rows (not a copy). This is why the live-verification
   run's local `attempts` count matched the guest baseline exactly — the rows never moved stores,
   they were relabeled.
3. **Unconditionally** (line 108-109, both branches): `supabase.rpc('recompute_stats')` —
   server-side only. Writes `profile_stats`/`theme_stats` rows, keyed by `auth.uid()` (confirmed
   directly in `20260908220000_recompute_stats_rpc.sql:44,91,100` — `v_profile_id := auth.uid()`,
   two `insert ... on conflict ... do update` statements targeting exactly those two tables). No
   `RETURNING`, no response payload of any kind — `recompute_stats()` returns `void`.
4. **Unconditionally** (line 111-121): reads local guest `preferences`
   (`getPreferences({identity: GUEST_IDENTITY})`) and upserts them to the remote `preferences`
   table. This is a REMOTE write only, in this function — nothing here writes a local `preferences`
   record for the new identity either (that happens later, see §1b).

**Confirmed: there is no line in `migrateGuestDataToAccount`, in either branch, that writes to the
local `profile` or `themeStats` IndexedDB stores for the new identity.** The function's own header
comment (line 20-26) states this outright and correctly, as a description of what changed, not as
a bug: *"Write order: puzzle_attempts → recompute_stats() → preferences. profile_stats/theme_stats
are no longer written directly here (Commit 6, ongoing sync) — recompute_stats() ... is the only
path allowed to write them going forward."* That sentence is true about the **server-side**
tables. It does not address — and, read literally, could be misread as implying — that the
**local** `profile`/`themeStats` stores are also handled somewhere. They are not, anywhere.

### 1b. Why `preferences` recovers but `profile`/`themeStats` don't

The live-verification runs showed local `preferences` correctly populated (`boardTheme: "wood"`,
`synced: true`, `lastPulledAt` set) after Merge — this could look like evidence that "the migration
path handles local state correctly, profile/themeStats are just missed." That's not what's
happening. Tracing `App.jsx`'s `onAuthenticated` callback (`App.jsx:362-366`) — the only thing
`handleMerge` calls after `migrateGuestDataToAccount` resolves — it just does three `setState`
calls (`setSession`, `setSessionStatus('valid')`, `setLaunchDismissed(true)`). Nothing there touches
storage either. What actually repopulates local `preferences` is the **login-trigger
`runSyncSequence`** (`App.jsx:206-228`), which fires from a *separate* `useEffect`
(`App.jsx:236-239`) keyed on `sessionStatus === 'valid'` — a transition this same `setSessionStatus`
call causes. `runSyncSequence` runs `pullRemoteAttempts()` → `flushUnsyncedAttempts()` →
`recompute_stats()` (again, redundantly, server-side) → `syncPreferences()`. `syncPreferences`'s
pull branch (`storage.js:365-409`) is what actually writes local `preferences` — reading the
just-upserted remote row and writing it into the local store. This is coincidental machinery built
for an unrelated purpose (ongoing cross-device preference sync), not something `migrateGuestDataToAccount`
or Merge intentionally arranged.

**There is no equivalent for `profile`/`themeStats`.** `runSyncSequence`'s four steps
(`pullRemoteAttempts`, `flushUnsyncedAttempts`, `recompute_stats`, `syncPreferences`) — confirmed by
reading every one of them — never read from `profile_stats` or `theme_stats` at all. A repository-
wide grep for `profile_stats` (`grep -rn profile_stats src/`) returns exactly one hit, and it's a
code comment (`LaunchOverlay.jsx:21`), not a query. There is no `pullProfileStats`,
`syncProfile`, or any function of that shape anywhere in `src/`. This isn't a call that exists and
silently fails or races — it's a call that was never written.

### 1c. `recompute_stats()` traced (`20260908220000_recompute_stats_rpc.sql`)

`SECURITY INVOKER`, no parameters, identity from `auth.uid()`. Computes `rating` as
`1200 + sum(rating_delta)` and `total_solved`/`total_failed` via `count(*) filter`, both over
`puzzle_attempts where profile_id = auth.uid()`; computes `current_streak`/`best_streak` via a
gaps-and-islands window-function scan of the same table. Writes both results via
`insert ... on conflict (profile_id) do update` into `profile_stats` and `theme_stats`
respectively. Confirmed idempotent and side-effect-free beyond those two upserts (pure derived
read of `puzzle_attempts`, no other table touched, no trigger side effects beyond the existing
sanity-bound CHECK constraints on those two tables). **Confirmed: nothing calls this RPC's result
back down to the client.** `supabase.rpc('recompute_stats')` is called from three places in
`src/` (`migrateGuestDataToAccount` twice-redundantly, and `App.jsx`'s `runSyncSequence`) — every
one of them discards the (empty, `void`) response and does nothing with it. The RPC does exactly
what it was built to do; nothing was ever built on the other end to consume it locally.

### 1d. Reachability: NOT scoped to Merge alone

This was the open question in the investigation prompt, and the answer is no.

Trace an ordinary Login (`handleLogin`, `LaunchOverlay.jsx:173-198`) on a device that has never
locally held data for this identity — a genuinely second device, or the same device with its
IndexedDB cleared:

1. `handleLogin` calls `verify-move-sequence`, gets a session, calls `supabase.auth.setSession()`,
   then `onAuthenticated(setSessionData.session)` — no migration check, no local storage write of
   any kind (confirmed: `handleLogin` has no `getAllAttempts`/`getProfile`/`storage.*` call at all).
2. `sessionStatus` flips to `'valid'`, `runSyncSequence` fires (the same login-trigger effect as
   §1b): `pullRemoteAttempts()` correctly fetches every server-side `puzzle_attempts` row for this
   account (no local watermark yet, so it's a full pull) and bulk-inserts them locally, correctly
   tagged `ownerId: identity` (`storage.js:759-846`, confirmed). **This part is genuinely correct**
   — the account's attempt history does come back.
3. But `getProfileFor(identity)` (`storage.js:104-109`) still returns `{ ...DEFAULT_PROFILE }`
   (rating `DEFAULT_RATING`/1200, `totalSolved: 0`, streaks `0`) — there is no local `profile`
   record under this identity's key, and nothing in step 2 writes one. `getThemeStats()`
   (`storage.js:421-436`) returns `{}` for the same reason.
4. `usePuzzleEngine.js`'s `loadPuzzle` (line 135-136) and `commitAttempt` (line 208-209) both call
   `getProfile()` directly — `userRating`/`streak` display, puzzle-difficulty-band selection
   (`nearestBands(profile.rating)`), and the NEXT solve's `updateRating(profile.rating, ...)` all
   run against the wrong (default) base, even though the account's true attempt history is now
   sitting locally, correct, right next to it.

**No local recompute-from-attempts function exists anywhere in `src/`** (confirmed: grepped for
`recomputeLocal`/`rebuildProfile`/any function matching `[Rr]ecompute` — zero matches outside the
Postgres RPC and its call sites) — so nothing self-heals this by deriving the aggregate from the
attempts that DID arrive correctly. The account's rating/streak/theme-accuracy stays wrong,
locally, on this device, indefinitely — until/unless this exact device later gets a local `profile`
row some other way (there isn't one).

This means the underlying defect is: **the client never implements a local pull-down of
`profile_stats`/`theme_stats`, full stop** — Merge is simply the specific path this investigation's
live-verification pass happened to exercise and catch, not the boundary of the bug.

**This is not a new category of risk for this project to discover — the project's own prior
investigation came close to naming it and stopped one step short.**
`storage-partitioning-investigation.md`'s "Second-device scenario" (lines 652-664) explicitly
analyzes "different device, same account, never had this legacy data locally" and concludes:
*"confirmed explicitly, unaffected ... that device's actual account history then arrives through
the already-shipped, already-working `pullRemoteAttempts()` mechanism."* That sentence is correct
about `attempts` and incomplete about everything else — it never checks whether `profile`/
`themeStats` arrive by any mechanism, and (per §1d above) they don't. The "unaffected" conclusion
holds only for the one store that document happened to check.

This is also a direct, checkable divergence from the AccountSync spec's own stated design intent,
not just an implementation gap nobody previously flagged:
- `Sharpin_Spec_AccountSync.md:85` (boot routing): *"valid local Supabase session on this device →
  skip any screen entirely, auto-resume directly into gameplay (**account data is already
  local/cached from the last sync** — see §6 for sync triggers)."*
- `Sharpin_Spec_AccountSync.md:95` (Login flow): *"On success → **pulls account data (rating,
  streak, needs-work areas) from Supabase.**"*

Neither of these describes what the shipped code does. The spec assumed a rating/streak/
theme-accuracy pull-down would exist; §6 ("Sync Triggers," the section the spec itself points to)
was written and built without ever including one.

---

## 2. Fix Design

Per the prompt's explicit caution against assuming symmetry with the `preferences` fix (the
established failure mode this session already caught twice — attempts-vs-preferences ordering,
push-vs-pull guard shape) — both candidates are evaluated independently, including one property
that turns out to make them *not* actually symmetric with `preferences` at all.

### Candidate (a): `migrateGuestDataToAccount` also writes local `profile`/`themeStats` directly

Compute the new identity's `profile`/`themeStats` from data already available locally (the guest's
attempts, already read into `localAttempts` at line 74), and write them via `saveProfile`/direct
`themeStats` puts under the new identity, inside `migrateGuestDataToAccount`.

**Partial-failure behavior:** the function's own doc comment (line 50-57) already accepts
non-atomicity — "if a later step throws, earlier steps in this call have already committed
remotely and are not rolled back." Placement matters for this fix specifically:
- Placed early (right after computing `localAttempts`, before any network call): a later throw
  (e.g. the `preferences` upsert failing) still leaves local `profile`/`themeStats` correctly
  populated. Strictly better than today's baseline (nothing written at all on any failure).
- Placed late (after the `preferences` upsert): a throw before reaching it leaves the same gap as
  today. No worse, but no better either.

**A genuinely non-trivial correctness trap, found by tracing the retry branch, not assumed:** on
a **retry** of `handleMerge` (the existing `existingRemoteAttempts > 0` branch, line 68 `if`
condition false) — which is a real, already-designed-for path, not a hypothetical — the guest's
attempts have ALREADY been reassigned to the new identity by the first attempt's
`markAttemptsSynced` call. `getAllAttempts({identity: GUEST_IDENTITY})` on the retry returns
**empty** (those rows no longer carry `ownerId: 'guest'`). A naive port of candidate (a) that
recomputes from `GUEST_IDENTITY`'s local attempts, called unconditionally the way `recompute_stats()`
already is (per that function's own stated retry-safety requirement), would compute and write an
**empty/default local profile on the retry pass — overwriting nothing today, but if it were ever
called after a first pass that DID succeed at writing the correct values, this would silently
regress a correct local value back to defaults.** The correct fix, if this direction is chosen,
must compute from the NEW identity's own attempts (`getAllAttempts({identity: userId})`, populated
either by the fresh insert this same call just made, or already present from a prior successful
pass) — not from the guest bucket, which is a moving target across retries by this function's own
existing design. This is exactly the kind of pattern-transfer trap the prompt asked to check for:
a "just do what recompute_stats() does, but locally" instinct would be silently wrong here.

**Scope limitation:** this direction only ever runs from inside `migrateGuestDataToAccount` — it
does nothing for §1d's second reachability path (ordinary Login on a device with no local record).
That gap would remain completely open even after this fix shipped.

### Candidate (b): pull-down parallel to `preferences`, wired into `runSyncSequence`

Add a `pullProfileStats()`-shaped function (naming TBD) that, after `recompute_stats()` runs,
reads `profile_stats`/`theme_stats` for the current session's identity and writes them into local
`profile`/`themeStats`. Called from `runSyncSequence` (fixing §1d generally, not just Merge) —
whether it also needs an explicit call inside `migrateGuestDataToAccount` itself depends on whether
Merge's `onAuthenticated` → `sessionStatus: 'valid'` transition reliably fires `runSyncSequence`
before the user would notice a wrong rating — worth checking at build time, not resolved here.

**Partial-failure behavior:** if the network call fails, local `profile`/`themeStats` simply stay
at whatever they already were (today's baseline for a first-time identity: `DEFAULT_PROFILE`/`{}`,
no worse than the current bug; for a device with a real existing local record: unchanged, correct,
no worse than not syncing at all). Retried automatically on the next login/foreground trigger, via
the exact same mutex-guarded mechanism `pullRemoteAttempts`/`syncPreferences` already use. This is
the established, already-proven resilience model in this codebase — not a new one.

**Checked, not assumed, for symmetry with `preferences` — and the answer is "less complexity
needed, not more":** `syncPreferences`'s careful push-vs-pull mutual-exclusion (`storage.js:305-364`)
exists specifically because `preferences` has a genuine **locally-pending, user-edited, not-yet-
pushed value** that a careless pull could clobber (`pendingToken`/`synced: false`). `profile_stats`/
`theme_stats` have **no such thing** — nothing in this codebase ever writes to them via user action;
they are 100% derived, read-only-from-the-client's-perspective aggregates, recomputed wholesale by
`recompute_stats()` every time it runs. There is no local edit to protect from a pull, ever. This
means a `profile`/`themeStats` pull-down can safely be a plain, unconditional "always overwrite
with the latest server values" — no `pendingToken`, no `updated_at`-compare-before-write gate, no
mutual-exclusion branch. Copying `syncPreferences`'s guard structure onto this would be over-built
for a problem this data shape doesn't have.

### Recommendation (Tiggs's call, not decided here)

**(b) is the stronger direction**, for two reasons that aren't about implementation convenience:
1. It's the only one of the two that closes §1d's second reachability path — (a) leaves ordinary
   multi-device Login permanently broken in the same way Merge is today.
2. Its failure mode degrades to "stays at today's already-broken default, retried automatically" —
   never worse than the status quo — whereas (a)'s retry-branch trap (above) has a real path to
   silently regressing an already-correct local value if not built carefully.

(a) is cheaper to build and touches only one already-well-understood function, but only patches
the specific path this investigation happened to catch, not the underlying gap.

---

## 3. What Would Prove the Fix Works

Whichever direction is chosen, the test that would have caught this originally is the cheapest,
highest-value one to add first: **extend the existing, already-passing
`LaunchOverlay.migration.test.jsx` Merge test** (`'Merge moves the guest attempt into the new
account's namespace...'`, line 130-153) to also assert `storage.getProfile()` and
`storage.getThemeStats()` for the new identity match what the seeded guest data implies — the test
currently seeds only one attempt and asserts only on `getAllAttempts()`. This needs a slightly
richer seed than the current single-attempt helper (`seedGuestAttempt`) to make the assertion
meaningful — at least two attempts with a mix of solved/failed across at least one repeated theme,
so `totalSolved`/`currentStreak`/`themeStats[theme].attempts` all have a non-trivial expected value
to check against, not just "non-zero."

**Adversarial case (per this project's established pattern — revert fix, confirm the new test
fails, restore):** seed guest `attempts` such that local `profile.rating`/`currentStreak` and
`themeStats` have specific, known values; run Merge; assert the new account's local `profile`/
`themeStats` match those exact values (not just "are non-default"); temporarily revert whichever
fix is chosen; confirm this specific new assertion fails for the traced reason (not a different,
unrelated failure); restore.

**If (a) is chosen**, an additional adversarial case is required for the retry-branch trap found
in §2: seed guest attempts, run Merge once (succeeds), then call `migrateGuestDataToAccount` a
second time (the retry branch) and confirm local `profile`/`themeStats` are UNCHANGED (not reset to
defaults) — this is the specific case a naive "recompute from GUEST_IDENTITY" implementation would
fail.

**If (b) is chosen**, a second, genuinely new test is needed (no existing test touches this path
at all): mock `profile_stats`/`theme_stats` rows server-side, simulate a device with an empty local
store for this identity (mirroring `clearAllStores()` in the existing migration test) going through
ordinary Login (not Create Account/Merge), and confirm local `profile`/`themeStats` get populated
from the mocked server rows after the login-trigger sync sequence runs.

**Beyond mocked tests:** per this project's established practice (every prior sync-correctness fix
in this session family — #1e/#1f, theme/preferences cross-device — was live-verified against real
Supabase before being called closed, not left at "mocked tests pass"), a live-verification pass
against production, following the same throwaway-account pattern `scratch-migration-verify.mjs`
already established, should be run before this is considered closed — see §4's explicit flag that
this requires separate authorization, not something to start now.

---

## 4. Scope Boundary

**`usePuzzleEngine.js` / #1d: no touch required, no interaction.** `usePuzzleEngine.js`'s
`loadPuzzle`/`commitAttempt` only ever call `getProfile()`/`recordAttempt()` — the *consumers* of
whatever `profile` store state exists, unmodified by either fix candidate. #1d's blocking
precondition is about `usePuzzleEngine`'s own effect racing `App.jsx`'s boot effect
(`adoptLegacyDataIfSafe`) for **pre-partitioning, bare-keyed legacy data** — a completely different
mechanism and a completely different class of local record than this bug, which is about
**post-partitioning, correctly-identity-keyed** local data that simply never gets written/pulled
in the first place. Confirmed independent: fixing this bug in either direction requires zero
changes to `usePuzzleEngine.js`, and fixing #1d requires zero changes to `migrateGuestDataToAccount`
or `runSyncSequence`. Either can be built before, after, or independently of the other — no
ordering dependency.

**#1e/#1f identity-pinned guards: fully independent, no overlap — with one forward-looking
caveat.** #1e/#1f guard `pushAttemptIfPossible`/`pushPreferencesIfPossible`/`pullRemoteAttempts`/
`syncPreferences` against a same-page-load identity **switch** during an in-flight operation. This
bug is not about a wrong-identity write racing anything — it's about a write that never happens at
all, at any identity, ever. Neither fix candidate touches any of the four guarded functions. The
one forward-looking note: if candidate (b) is built, its new pull-down function will itself resolve
`getSession()`/identity at least once — whoever builds it should follow the same identity-pinning
discipline #1e/#1f already established as this project's standard for any new session-resolving
code (pin once, thread through, don't re-resolve mid-operation), as a matter of consistency with
the existing codebase pattern, not because it modifies anything #1e/#1f already built.

**Could local mocked tests (fake-indexeddb/jsdom) have caught this? Yes, easily — and this is a
meaningfully different "why it wasn't caught" than #1f's.** CLAUDE.md's existing technical-learnings
entry for #1f describes a genuine *mock-fidelity gap*: the mocked test suite structurally could not
see an SDK-internal call the real `@supabase/supabase-js` client makes on its own. That is not what
happened here. `LaunchOverlay.migration.test.jsx`'s Merge test (confirmed by direct read, §3 above)
already renders the real, unmocked `storage.js` against `fake-indexeddb`, already drives the real
`handleMerge`/`migrateGuestDataToAccount` code path, and was already perfectly capable of exposing
this — it simply never asserts on `storage.getProfile()` or `storage.getThemeStats()` at all. This
is a plain **test-coverage gap** (an assertion nobody wrote), not a fidelity gap (an assertion that
would have given a misleadingly correct answer). One added assertion to an already-existing,
already-passing mocked test would have caught this without ever touching live Supabase — worth
stating plainly since the two failure modes call for different remediation (coverage gaps are
fixed by writing the missing assertion; fidelity gaps require deriving expected values from a live,
instrumented run, per the #1f precedent already logged in CLAUDE.md).

---

## 5. Open Questions / Risks

- **Backlog framing, stated plainly per the prompt's request:** this blocks, at minimum, the
  guest-to-account Merge flow from being considered correct or ready for real users. Per §1d, it
  also blocks something broader — the "cross-device profile sync" backlog claim (#1) itself, which
  CLAUDE.md's "Current task" section currently describes as *"complete for everything currently
  scoped."* An ordinary second-device Login silently showing a wrong rating/streak/theme-accuracy
  is a direct miss against the AccountSync spec's own §5/boot-routing intent (quoted in §1d), not
  an edge case outside that backlog item's stated goal. Whether CLAUDE.md's "complete" framing
  should be revised is Tiggs's call — flagged here, not changed (per the investigation-only scope
  of this pass).
- **Refresh cadence for candidate (b), if chosen:** should the pull-down run on every
  login/foreground trigger (matching `recompute_stats()`'s own idempotent, cheap-to-recompute
  nature — keeps a multi-device user's displayed rating fresher after solving on another device),
  or only when the local `profile`/`themeStats` record is entirely absent (cheaper, but a second
  device would then show a stale rating indefinitely after the FIRST successful pull, same
  staleness risk `preferences`' own LWW design already accepts elsewhere)? Real cost/freshness
  tradeoff, not resolved here.
- **Sequencing against #1d:** no ordering dependency exists (§4), but both are now open, blocking
  items against the same broader backlog area — worth Tiggs deciding which to schedule first purely
  as a planning matter, not a technical constraint either finding imposes on the other.
- **Live-write / production-Supabase scope:** this investigation made zero writes anywhere (all
  findings above are from direct code/schema/doc reads). Building and verifying the eventual fix
  will need the same real-Supabase, throwaway-account live-verification pattern this whole project
  has consistently required before calling a sync-correctness fix closed — including, per §1d,
  likely a second live-verification pass specifically for the ordinary-Login-on-a-new-device path
  (two independent sessions on one account, mirroring the theme/preferences cross-device
  verification's own accepted substitute for literal separate browser contexts). **Do not proceed
  on any of that without explicit confirmation** — flagged here per the prompt's own instruction,
  not started.
