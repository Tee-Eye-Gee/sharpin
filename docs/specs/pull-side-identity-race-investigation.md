# Investigation: Pull-Side Identity Race (Backlog #1f, NEW, blocking)

Status: **Findings only — no code changes, no commits, no writes to Supabase (local or
production).** For review before Logout (#2) scope is locked.
Date: 2026-09-12

Prerequisite reading (per the prompt, both reviewed before writing anything below): `CLAUDE.md`
(storage-partitioning section, theme/preferences-sync section) and
`docs/specs/identity-pinned-push-guard-investigation.md` in full, specifically its §3 "adjacent
finding" on `pullRemoteAttempts` and `syncPreferences`'s pull branch. That finding was a byproduct
of tracing the push-side fix, not an independently-investigated claim — this document re-derives
it from scratch, as instructed, rather than assuming its characterization was complete. **It
wasn't, in one specific way: the prior doc undercounted the number of independent identity/session
resolutions inside `pullRemoteAttempts`.** Corrected below.

---

## 1. Exact Failure Mechanics

### `pullRemoteAttempts` — four resolution points, not two

Re-reading `storage.js:670-734` line by line, not from the prior summary: this function resolves
identity/session **four** separate times, not the two the prior document named (it only flagged
the divergence between the top-level `session` and the final `savePreferences` call):

| # | Line | Call | Resolves via | Used for |
|---|------|------|--------------|----------|
| 1 | 673 | `supabase.auth.getSession()` | explicit | `.eq('profile_id', session.user.id)` (query filter, line 682); `ownerId: session.user.id` on inserted rows (line 711) |
| 2 | 676 | `getPreferences()` (no override) | `resolveIdentity()` internally | reads `prefs.lastPulledAt` as the query's watermark |
| 3 | 693 | `getAllAttempts()` (no override) | `resolveIdentity()` internally | builds `existingRemoteIds` for the dedup filter |
| 4 | 731 | `savePreferences(...)` (no override) | `resolveIdentity()` internally | writes the advanced `lastPulledAt` watermark |

**Not all four gaps are equally reachable — this matters for prioritizing the fix, and the prior
document's summary obscured it by only naming the last one.** Tracing the actual control flow
between each pair:

- **Point 1 → Point 2**: no network or IndexedDB operation happens between them — point 2 is
  reached immediately after point 1 resolves. Confirmed against the installed
  `@supabase/auth-js`'s `getSession()` (`node_modules/@supabase/auth-js/dist/module/
  GoTrueClient.js:2398-2411`, `_useSession`/`__loadSession`): for the common case (a valid,
  not-imminently-expiring session), the whole call resolves through a chain of `Promise`s with no
  network `fetch` and no `setTimeout` — i.e., microtasks only. JS's run-to-completion guarantee
  means a queued browser event (a real user's Logout/Login click) **cannot** be processed in
  between two back-to-back microtask-only `await`s with nothing macrotask-yielding in between.
  **This specific gap is not realistically reachable by a user-driven identity switch.**
- **Point 2 → [network fetch, line 679-683] → Point 3**: a real network round-trip
  (`supabase.from('puzzle_attempts').select(...)`) sits between points 2 and 3. This **is** a
  genuine macrotask-yielding operation — the browser's event loop gets a real opportunity to
  process a pending click here, for as long as the request takes (realistically tens to hundreds
  of milliseconds, longer on a degraded connection). **This gap is realistically reachable.**
- **Point 3 → [IndexedDB write, if `newRows.length > 0`] → Point 4**: `store.add(...)` calls
  inside an IndexedDB transaction resolve via the browser's task queue (request `onsuccess`/
  `onerror` events), not pure microtasks — typically fast, but a real task-queue boundary, not
  provably unreachable the way point 1→2 is. **This gap is narrower than point 2→3 but not
  dismissible as impossible.**

**Corrected conclusion: points 3 and 4 (not just point 4) are both realistically exposed to a
same-page-load identity switch, independently of each other, because both sit after the query's
real network round-trip. Points 1 and 2 are effectively safe from this specific race by
construction of the JS event loop, not by any code in this file.**

### What each divergence actually produces — traced concretely, not described generally

**Scenario: Account A is live at point 1, logs out, logs into Account B, and B's session is what's
live by the time points 3 and/or 4 run.**

- **Point 3 diverges (dedup check runs under B, not A):** `existingRemoteIds` is built from **B's**
  local attempts, not A's. The `newRows` filter (line 694) then fails to recognize rows A already
  has locally as "already present," because it's comparing against the wrong identity's set. The
  `store.add(...)` calls that follow still correctly tag `ownerId: session.user.id` — **but that
  value is point 1's `session`, which is fixed at the top of the closure and does not itself drift
  just because point 3 drifted** (points 1 and 3 are independent variables, not the same
  re-resolved value — this is worth being precise about: point 3 diverging doesn't retroactively
  change what point 1 already captured). So the practical effect is: **duplicate rows inserted
  under A's own `ownerId`**, not a cross-account leak — A ends up with two local copies of some
  already-pulled attempts. Both copies are tagged `synced: true` (line 709), so neither gets
  swept into a re-push storm. This corrupts A's own recency-weighted puzzle selection
  (`getRecentAttempts`) and the coach layer's "recent occurrences of a theme" logic (both consumers
  named in `CLAUDE.md`), a real but narrower, non-leaking, non-data-loss corruption.
- **Point 4 diverges (watermark write lands under B's `preferences` record, not A's):** this is
  the case the prior document already named, now confirmed precisely: **A's own `lastPulledAt`
  watermark is never actually advanced** (A's real preferences record is untouched by this write),
  and **B's watermark is falsely advanced** to a timestamp taken from A's pull (`maxUpdatedAt`,
  computed from data queried under A's `profile_id`). Two independent downstream consequences:
  - A's next pull re-queries from the same old watermark and re-fetches the same rows — wasteful
    (one extra round trip) but not lossy, since the dedup check (point 3) will now correctly
    recognize them as already-present (assuming point 3 itself didn't *also* diverge on this same
    pull).
  - **B's next pull silently skips any of B's own real `puzzle_attempts` updates whose
    `updated_at` falls at or before A's `maxUpdatedAt`, even if B never actually pulled them.**
    This is the "silent, permanent data omission" the task description names precisely: B is never
    told anything failed, nothing crashes, B's UI simply never shows those rows, and there is no
    error state anywhere for anyone to notice.

### `syncPreferences`'s pull branch — two resolution points, structurally different in kind

Re-reading `storage.js:324-364`:

| # | Line | Call | Used for |
|---|------|------|----------|
| A | 327 | `resolveIdentity()` | reads `local` (line 328, `getPreferencesFor(identity)`); is the **write target** for the final `savePreferencesFor(..., identity)` (line 354) |
| B | 342 | `supabase.auth.getSession()` (only reached if `local.synced === true`) | `.eq('profile_id', session.user.id)` (query filter, line 348) |

Only reached when `local.synced` is `true` — i.e., this whole branch is skipped entirely (goes to
the push-retry branch instead, `pushPreferencesIfPossible`) whenever there's a genuinely pending
local edit. **Point A → Point B**: `getPreferencesFor(identity)` (line 328) is an IndexedDB read —
same task-queue-boundary caveat as `pullRemoteAttempts`'s point 3→4 gap above: fast, but not
provably unreachable. **Point B → the final write (line 354, using Point A's `identity`)**: a real
network round-trip (`.select(...).maybeSingle()`) sits in between — realistically reachable, same
reasoning as `pullRemoteAttempts`'s point 2→3 gap.

**Concrete scenario: `identity` resolves to A at point A; by the time point B's `getSession()`
runs (or by the time the network query it authorizes resolves), B is live instead.** The `SELECT`
queries **B's** real `preferences` row (`.eq('profile_id', session.user.id)` uses B's id). The
comparison `data.updated_at <= local.preferencesUpdatedAt` (line 352) compares **B's** row's
timestamp against **A's** locally-stored watermark — two unrelated accounts' timestamps, compared
as if they meant something relative to each other. If that comparison happens to evaluate as "B's
timestamp is newer" (essentially arbitrary, depending only on which account happened to save
preferences more recently — nothing to do with real precedence), the function proceeds to
`savePreferencesFor({ ...local, appMode: data.app_mode, boardTheme: data.board_theme, inputMode:
data.input_mode, preferencesUpdatedAt: data.updated_at }, identity)` — **writing B's real
board_theme/app_mode/input_mode into A's local `identity`-keyed record.** This is exactly the
"silent, wrong-but-plausible value" the task asked to characterize precisely: A's device would now
visibly show B's board theme, with no error, no crash, and a value that looks completely legitimate
(it's real data, just from the wrong account). If the comparison instead evaluates the other way,
the function simply returns with no write at all — accidental luck, not a guard, and not something
to rely on.

### Is any of this reachable today, or is it purely a forward risk? — Traced, stated plainly

**Purely a forward risk. Not reachable in the shipped app today.** Both entry points require an
already-live session to proceed past their own first guard:
- `pullRemoteAttempts` line 674: `if (!session) return { pulled: 0 }` — a guest can never get past
  this line, so points 2-4 are unreachable for a guest-starting state.
- `syncPreferences`'s pull branch is only reached when `local.synced === true`, and its own line
  343 (`if (!session) return`) means a guest can never proceed past point B either.

The only way to reach the *risky* interior of either function at all is to already have a real
session at the point of entry — and the only same-page-load identity transition possible in the
shipped app today is `none → valid` (guest → account, via Create Account/Login), never `valid →
none` or `valid(A) → valid(B)` (confirmed: no `signOut()` call exists anywhere in `src/` or
`supabase/`, reconfirmed this session). A guest-starting pull can't even begin the risky part of
either function, and there is no code path today that could make the *live* session change out
from under an *already-in-progress* pull for a real account, because nothing can end that account's
session mid-page-load. **This entire failure family requires Logout to exist before it becomes
reachable at all** — consistent with, and now more precisely confirmed than, the framing already
used in `logout-investigation.md` and the #1e document for the equivalent push-side risk.

---

## 2. Fix Design — Not Symmetric With the Push-Side Guard, By Design, Not By Oversight

### Why the push-side shape (pin once, compare against a fresh resolution, abort on mismatch) is the wrong model for most of this

The push-side fix (#1e) exists because a fire-and-forget push **structurally must** re-resolve the
session at execution time — it might run long after the write was queued, and it needs a currently
*valid* auth token to make the call at all, which a value pinned at initiation time can't
guarantee. Its fix is therefore a genuine two-source comparison: a value captured *before* an
uncertain async gap, checked against a value that's *necessarily* re-derived *after* it.

**`pullRemoteAttempts`'s internal calls (points 2, 3, 4) have no equivalent structural need to
re-resolve independently.** They are not bridging a deliberate, open-ended async handoff — they are
three purely **local** IndexedDB operations (`getPreferences`, `getAllAttempts`, `savePreferences`),
each redundantly re-deriving the exact same fact (`resolveIdentity()`) that the *calling* function
already derived at point 1, moments earlier, for its own purposes. None of the three need a live,
freshly-authenticated session — they need to know which storage key/tag to use, and `session.user.id`
from point 1 already answers that. **The correct fix here is not a guard at all: it's eliminating
the redundant re-resolutions by threading the identity pinned at point 1 through explicitly,
using parameters that mostly already exist:**

- `getPreferences({ identity: session.user.id })` — the override parameter already exists
  (`storage.js:177`, built originally for `LaunchOverlay.jsx`'s guest-namespace-override use case).
- `getAllAttempts({ identity: session.user.id })` — same, already exists (`storage.js:483`).
- The watermark write (currently `savePreferences(...)`, `storage.js:198-201`, which has **no**
  identity-override parameter today — confirmed by re-reading it, and consistent with `CLAUDE.md`'s
  own Conventions list, which names `getAllAttempts`/`getPreferences`/`resetAllLocalData`/
  `markAttemptsSynced` as the functions with this override and does not list `savePreferences`).
  Two ways to close this, both small: add the same optional `{ identity }` override to the public
  `savePreferences` (consistent with the existing pattern), or have `pullRemoteAttempts` call the
  already-existing **private** `savePreferencesFor(preferences, identity)` directly — it's defined
  in the same module and already takes an explicit identity, so no new public surface is even
  required.

This structurally **prevents** the divergence rather than detecting it after the fact — stronger
than a check-and-abort guard, and it removes three redundant `getSession()`/`resolveIdentity()`
calls in the process (a minor performance win, not the point, but worth noting). **No new
comparison logic, no new "what happens on mismatch" behavior to design for points 2-4, because
there is no longer a second resolution left to disagree with the first.**

### Why `syncPreferences`'s pull branch genuinely does need a guard, not just pinning

Unlike `pullRemoteAttempts`'s internal calls, `syncPreferences`'s point B (`getSession()`,
line 342) is **not** purely redundant with point A (`resolveIdentity()`, line 327) — it exists to
obtain the live session needed to authorize the actual outbound `preferences` query, and it also
does legitimate, necessary work point A alone can't: point A's `identity` can be `GUEST_IDENTITY`
even when this branch is reached (nothing before it distinguishes guest from account — only
`local.synced` gates the push/pull branch choice), and `.eq('profile_id', identity)` would be
nonsensical for a literal `'guest'` string. Point B's `if (!session) return` (line 343) is what
correctly short-circuits the guest case here. **Removing point B and reusing `identity` directly
would be wrong, not just risky** — it would either misfire the query for guests or, if guarded
separately, still leave the exact identity-agreement question unanswered.

**The correct fix here is closer in shape to the push-side guard — but the response to a detected
mismatch should reuse a pattern already present in this exact function, not invent a new one:**

```js
const { data: { session } } = await supabase.auth.getSession()
if (!session) return
if (session.user.id !== identity) return   // NEW -- treat exactly like "no session"
```

Placed immediately after the existing `if (!session) return`, this is a one-line, pattern-consistent
addition — a detected mismatch is handled **identically** to the no-session case the function
already has a correct, tested answer for: do nothing, leave `local` untouched, return. This is
justified, not just convenient: for a **single mutable row** (unlike attempts' append-only model),
there is no safe partial or "best guess" action on a mismatch — any write under uncertain identity
directly overwrites the only copy of that identity's current settings, so the only correct response
is to do nothing at all and let the next trigger (a fresh login, or the next foreground event —
both of which already exist and already re-invoke `syncPreferences` via `runSyncSequence`) retry
under whatever identity is actually live by then.

### Attempts (append-only) vs. preferences (single mutable row) — the distinction the task asked not to assume away

This is exactly why the two functions need **different** fix shapes, not the same one:
- Attempts data pulled under a momentarily-wrong internal resolution (points 2/3) produces, at
  worst, **duplicate rows under the correct owner** (§1) — recoverable, self-correcting on a later
  correctly-scoped pull, because appending is forgiving of redundancy. Point 4's watermark is the
  one non-append-only piece of state `pullRemoteAttempts` touches, which is exactly why it's the
  one place a stronger fix (pin-and-thread, not just accept-and-hope) matters most within that
  function.
- Preferences is a single row with no append/dedup safety net at all — a wrong write there isn't
  "duplicated," it's **overwritten and gone**. That asymmetry is why `syncPreferences`'s pull
  branch needs an explicit abort-on-mismatch guard rather than relying on pin-and-thread alone
  (there's only one write, and it has to either be provably correct or not happen).

### What tests would prove each fix works, including the adversarial case

**`pullRemoteAttempts` (pin-and-thread):**
- Controlled-race test (same manually-resolved-promise technique already established in
  `storage.preferencesOutOfOrder.test.js`): identity is A at point 1; mock the live session to
  report B by the time points 3/4 would naively re-resolve. Assert the pull **still completes
  correctly under A** — A's local attempts store contains the newly-pulled rows, tagged
  `ownerId: 'A'`, and A's own `preferencesUpdatedAt`... actually `lastPulledAt` (via A's
  preferences record) is correctly advanced. Assert B's local state is completely untouched.
  **This is a different assertion shape than a guard test** — it proves the operation *succeeds*
  for the *original* identity despite the live session having moved on, not that it aborts.
- Adversarial: temporarily revert the fix (let the three inner calls auto-resolve again) and
  confirm this same test now fails — specifically, that it fails by showing corruption (wrong
  watermark target, or a duplicate row), not by erroring out for an unrelated reason — so the test
  is proven to actually detect the bug, not just coincidentally sensitive to something else.

**`syncPreferences`'s pull branch (guard):**
- Controlled-race test: identity is A at point A; mock session switches to B before point B
  resolves. Assert the function returns without writing anything — A's local record is byte-for-
  byte unchanged from before the call. Assert the mocked remote `select` was still invoked (it
  legitimately queried under B, that part is fine and expected) but its result was never applied
  locally.
- A companion, non-racing test confirming the ordinary case (identity stable throughout) still
  pulls and applies correctly — guards against an over-aggressive guard breaking the already-shipped,
  already-tested pull behavior in `storage.preferencesSync.test.js`.
- Adversarial: temporarily remove the one-line guard, confirm the racing test now fails by showing
  A's record actually got overwritten with B's values — proving the test catches the real
  corruption, not a false positive.

---

## 3. Interaction With #1e

**Fully independent at the code level.** The two fixes touch entirely different functions
(`pushAttemptIfPossible`/`pushPreferencesIfPossible` vs. `pullRemoteAttempts`/`syncPreferences`'s
pull branch), triggered by entirely different events (a fire-and-forget dispatch from
`recordAttempt`/`updatePreferences` vs. `runSyncSequence`'s pull step), sharing no mutable state or
call relationship. Implementing one does not require or block the other.

**Timing interaction: negligible, and if anything favorable.** The pull-side fix removes three
redundant `getSession()`/`resolveIdentity()` calls from `pullRemoteAttempts` (replaced by
already-resolved parameters) — this makes the function slightly *faster*, which can only narrow,
never widen, whatever race window remains between its own internal steps. It has no effect on the
timing of the *push*-side functions at all, since they're never called from within
`pullRemoteAttempts`/`syncPreferences`'s pull branch.

**Test-coverage interaction worth naming:** `runSyncSequence` (`App.jsx:184-206`) calls
`pullRemoteAttempts()` → `flushUnsyncedAttempts()` (which calls `pushAttemptIfPossible` per row) →
`recompute_stats()` → `syncPreferences()` (whose push branch also calls
`pushPreferencesIfPossible`), all in one sequential chain. **A single identity switch occurring
early in this chain (during the pull step) could still be live by the time the flush/push steps
run later in the same chain**, meaning an end-to-end test of "identity switches mid-`runSyncSequence`"
would naturally exercise both fixes together. Recommend adding this as a **third, higher-level**
test once both fixes exist, in addition to (not instead of) each fix's own isolated unit tests —
consistent with this project's existing pattern of both narrow, single-function test files and
addendum-style integration checks.

**Recommendation on bundling — a scope call for Tiggs, not decided here:** given they're
code-independent but block the same precondition (Logout, #2) and were surfaced by the same
investigative thread, recommend shipping as **two separate, small commits** (matching this
project's established single-concern-per-commit convention, and making each individually easy to
review and individually test-adversarial-verify per §2) **landing in the same build pass**, so
Logout's blocking status doesn't get treated as cleared after only one of the two ships. Stated as
a recommendation, not a decision.

---

## 4. The Flagged Existing Test — Investigated, Empirically Confirmed

The #1e document raised, but did not resolve, a concern that `storage.identity.test.js` (lines
72-102) might already be incidentally racing this bug family, since it switches
`mockGetSession`'s resolved value from guest to `'acct-1'` immediately after an un-awaited
`recordAttempt(...)` call. **Investigated directly, both by tracing JS's execution semantics and
by empirically reproducing the exact sequence in an instrumented, temporary test (written,
run, and deleted as part of this investigation — no committed code changes):**

**Confirmed: this specific test does NOT race the bug. The concern was unfounded for this
test, though the underlying reasoning that raised it (async fire-and-forget racing a same-tick
mock switch) is sound in general — it just doesn't apply here.**

Why not, traced precisely: `recordAttempt`'s fire-and-forget dispatch,
`pushAttemptIfPossible({...}).catch(() => {})`, is a plain (non-awaited) call. Because calling an
`async` function executes its body **synchronously up to its first `await`**,
`pushAttemptIfPossible`'s own `await supabase.auth.getSession()` line — i.e., the call to the mock
function itself — happens synchronously, **before** `recordAttempt`'s subsequent `return updated`
statement executes. Since the test's outer `await storage.recordAttempt(...)` can only resolve
*after* that `return` has already run, the mock function call underneath the fire-and-forget push
is *guaranteed* to have already happened — capturing whatever `mockGetSession` was configured to
resolve at that exact synchronous moment (`sessionOf(null)`) — **before** the test's very next line
(`mockGetSession.mockResolvedValue(sessionOf('acct-1'))`) has any chance to run. `vi.fn().
mockResolvedValue(x)` bakes in `x` at call time, not at whenever the returned promise happens to
settle, so the later switch cannot retroactively change what an already-issued call captured.

**Empirical confirmation:** an instrumented, temporary test reproducing this exact sequence (mock
`insert` recording every `profile_id` it was ever called with) showed **zero calls** to the mocked
insert for the guest attempt's push — i.e., `pushAttemptIfPossible` correctly resolved `session ===
null` and hit its own `if (!session) return` guard, exactly as the trace above predicts. The
file was not committed (deleted immediately after this check).

**What this generalizes to, precisely, since the concern itself was reasonable to raise:** the
push-side race (#1e) is real and reachable, but **only across a genuine macrotask-yielding gap** —
in `pushAttemptIfPossible`'s case, that gap is the real network `insert()` call itself (once a
session already exists and the function proceeds past its own `if (!session) return`), not the
earlier `getSession()` call. A test (or a real scenario) that only interleaves an identity switch
around a *local*, microtask-only `getSession()` resolution — as `storage.identity.test.js`'s
existing test happens to do — cannot reach this bug, guest-starting or not. **No missing assertion
needs to be added to that specific existing test** — it isn't silently exercising this bug, it's
simply not constructed in a way that could.

---

## 5. Scope Boundary

- **Confirmed: this investigation and its proposed fixes do not touch, and do not need to touch,
  `usePuzzleEngine.js` or any code covered by the #1d blocking precondition.** Every function
  traced above (`pullRemoteAttempts`, `syncPreferences`, `getPreferences`, `getAllAttempts`,
  `savePreferences`/`savePreferencesFor`) lives in `storage.js`; none of them are called by, or
  call into, `usePuzzleEngine.js`. #1d's own scope (the `loadPuzzle`-vs-boot-effect ordering race
  corrupting `ratingDelta`) is a completely separate mechanism with no shared code path.
- **Confirmed: this fix does not require Logout to exist, and should be investigated/built and
  verified using a simulated identity switch, not a real logout flow.** §1 already established the
  bug is a pure forward risk with no live trigger today — the same controlled-mock-switch technique
  used throughout §2's test plan (and empirically demonstrated working, in the diagnostic run for
  §4) is sufficient to build and verify both fixes well ahead of Logout actually shipping, exactly
  as #1e's own verification plan already assumed for the push side.

---

## 6. Open Questions / Risks

1. **The `savePreferences` override-parameter gap (§2)** — a small, additive API surface decision
   (add `{ identity }` to the public function, matching the existing convention, vs. having
   `pullRemoteAttempts` call the private `savePreferencesFor` directly) needs a call at build time.
   Recommend the public-override route for consistency with `CLAUDE.md`'s own documented
   convention list, but flagging both as viable, low-risk options rather than picking one here.
2. **The point 3 (dedup) duplicate-row consequence (§1)** is real but the least severe finding in
   this document — worth fixing as part of the same pin-and-thread change (it's free, since the
   same parameter already exists), not worth scoping as a separate, standalone concern.
3. **Bundling with #1e** (§3) — explicitly a recommendation, not a decision; flagged again here so
   it isn't missed among the more technical findings.
4. Nothing in this investigation surfaced a need to re-open `adoptLegacyDataIfSafe` or its
   guest-vs-stranded heuristic (already confirmed correct as-is in `logout-investigation.md` §5) —
   this pull-side race and that routine are unrelated: the adoption routine runs once, at boot,
   before any of the functions traced here are ever reached that boot.

### Production Supabase / live-write scope check

Per standing rule, flagging explicitly: **this investigation required no live writes and proposes
none.** All tracing was against local code (`storage.js`) and the installed `@supabase/auth-js`
library source already present in `node_modules`. The one executable step taken during this
investigation — the temporary diagnostic test in §4 — ran entirely against `fake-indexeddb` and a
fully mocked Supabase client, made zero real network calls, and was deleted immediately after
running; it is not reflected in the working tree. Building and verifying the fixes designed here
(§2's test plans) likewise requires no live writes — both are designed to be fully provable with
mocked/controlled sessions, consistent with §5's confirmation that Logout need not exist first. Any
eventual live, two-real-account verification (mirroring #1e's own Level 2 plan) would still need
its own before-not-after confirmation when that work actually starts, per the standing rule.
