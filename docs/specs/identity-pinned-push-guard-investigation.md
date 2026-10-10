# Investigation: Identity-Pinned Push Guard (Backlog #1e, NEW, blocking)

Status: **Findings only — no code changes, no commits, no writes to Supabase (local or
production).** For review before Logout (#2) scope is locked.
Date: 2026-09-12

Prerequisite reading (per the prompt, both reviewed before writing anything below): `CLAUDE.md`
(storage-partitioning section, theme/preferences-sync section) and
`docs/specs/logout-investigation.md` §2 ("Logout mechanics"), which surfaced this bug as a
byproduct of tracing logout's own build scope, not as something originally investigated for its
own sake. This document exists to finish that trace: design and evaluate a concrete fix, without
implementing it.

**Bottom line up front:** the bug is real, confirmed against the current code (unchanged since
§2 was written). The fix is smaller and lower-risk than the prior document's own tentative sketch
suggested — both push functions already have everything they need to pin identity correctly; no
new parameter threading is required for either one. Tracing the fix shape surfaced one adjacent,
same-shaped instance of the identical pattern on the **pull** side, not previously named — flagged
below as additional, not originally scoped, because the underlying vulnerability class (resolving
identity/session more than once within what should be one atomic logical operation) turns out not
to be limited to the two push functions #1e named.

---

## 1. The Bug, Reconfirmed Against Current Code

No code has changed since `logout-investigation.md` §2 was written — re-read directly, not
assumed:

- **`pushAttemptIfPossible`** (`storage.js:601-623`): `const { data: { session } } = await
  supabase.auth.getSession()` (line 604) resolves the session fresh, at execution time.
  `profile_id: session.user.id` (line 609) uses that fresh value directly. The `attempt` parameter
  it receives already carries `attempt.ownerId` — resolved and frozen onto the record back in
  `recordAttempt` (line 782, `ownerId: identity`) — but nothing in `pushAttemptIfPossible` ever
  reads or compares against it.
- **`pushPreferencesIfPossible`** (`storage.js:233-254`): identical shape. `session.user.id`
  (line 236) is used directly as the upsert's `profile_id` (line 242). The function already
  receives an `identity` parameter (added for the `pendingToken` guard, threaded from
  `updatePreferences`/`syncPreferences`), but — same as above — nothing compares it against the
  freshly-resolved `session.user.id` before the write.

**RLS reconfirmed as no help** (`supabase/migrations/20260819140001_rls_policies.sql:33-38` and
the identical `preferences` policy): both tables are `using (auth.uid() = profile_id) with check
(auth.uid() = profile_id)`. Since the vulnerable code always sets `profile_id` from the *same*
session it authenticates the call with, the write is tautologically self-consistent from RLS's
point of view regardless of which identity is actually live — RLS cannot distinguish "the right
account wrote this" from "whichever account happens to be logged in right now wrote this."

No new information changes the severity assessment from §2: this remains a real, exploitable
cross-account attribution/corruption path once Logout allows a same-page-load `valid(A) →
valid(B)` transition, and a narrower, already-latent version (guest → account direction) exists
today, independent of Logout, that breaks Discard's guarantee in a rare race window.

---

## 2. Candidate Fix, Designed Concretely

### `pushAttemptIfPossible` — simpler than the prior sketch: no new parameter needed

`logout-investigation.md` §2 proposed threading a pinned identity through as a new parameter,
"mirroring the already-shipped `pendingToken` guard." **Tracing it concretely shows this isn't
necessary for this function — the pinned value already exists on the object being passed in.**
Every call site's `attempt` argument already carries `ownerId`, frozen at the moment the record was
created (`recordAttempt`, line 782) and never mutated afterward:

```js
async function pushAttemptIfPossible(attempt) {
  if (!ACCOUNT_SYNC_ENABLED) return

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return
  if (session.user.id !== attempt.ownerId) return   // NEW -- before any network call

  const { error } = await supabase.from('puzzle_attempts').insert({ ... })
  ...
}
```

**Placement is the load-bearing detail, not the comparison itself**: the check must sit *before*
the `insert` call, not after. Checking afterward (e.g., only gating whether `markAttemptSynced`
runs) would still let the wrong-account write land server-side before catching the mismatch — it
would stop the *local* bookkeeping error but not the *remote* corruption, which is the actual harm
being closed. Placed before the network call, a mismatch aborts the whole push cleanly: no request
is sent, the local row is untouched (`synced: false`, exactly as if the push simply hadn't run
yet), and it becomes eligible for a later, correctly-scoped retry once its own identity's session
is live again.

**Both call sites already supply a correct, frozen `ownerId` — confirmed, not assumed:**
- `recordAttempt` → `pushAttemptIfPossible({ ...attemptRecord, id: localId })`: `ownerId` set once,
  up front, in `attemptRecord`'s construction.
- `flushUnsyncedAttempts` → `pushAttemptIfPossible(attempt)` for each row from
  `getUnsyncedAttempts()`: that function already filters `a.ownerId === identity` at read time
  (`storage.js:509`), and `withSyncedDefault`/`withHintUsedDefault` both spread `...attempt`,
  preserving `ownerId` unchanged in the object handed back. Even if the live session changes
  *mid-loop* (a real possibility — `flushUnsyncedAttempts` awaits each push sequentially), the
  snapshot array was already correctly scoped to whichever identity was active when
  `getUnsyncedAttempts()` was called, so `attempt.ownerId` still correctly reflects each row's true
  owner regardless of what happens to the live session while the loop is running. No change needed
  to `flushUnsyncedAttempts` or `getUnsyncedAttempts` themselves.

### `pushPreferencesIfPossible` — also simpler than the prior sketch: the parameter already exists

The function's signature is already `pushPreferencesIfPossible(prefs, identity, pendingToken)` —
`identity` is already threaded through from both call sites (`updatePreferences`'s click path and
`syncPreferences`'s retry-branch), added when the `pendingToken` guard was built. **No new
parameter is needed here either** — the fix is one line, in the same position as the attempts-side
fix:

```js
async function pushPreferencesIfPossible(prefs, identity, pendingToken) {
  if (!ACCOUNT_SYNC_ENABLED) return

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return
  if (session.user.id !== identity) return   // NEW -- before any network call

  const { data, error } = await supabase.from('preferences').upsert(...)
  ...
}
```

Same placement rule applies: before the upsert, not after. This is the more urgent of the two
placements to get right, because `preferences` is a single-row upsert with no dedup/append
semantics — a write that lands under the wrong `profile_id` here doesn't just create a stray
duplicate row (as a mis-attributed `puzzle_attempts` insert would), it **overwrites** whatever
that account's real preferences already were, immediately, unconditionally.

### A useful side effect worth naming explicitly

With this guard in place, a genuine guest's stray push (the already-latent, pre-Logout direction
named in §1) can **never** succeed under a real account's `profile_id` either —
`session.user.id` is a UUID; `attempt.ownerId`/`identity` for a guest record is the literal string
`'guest'`; they can never compare equal. This closes the narrower "breaks Discard's guarantee in a
rare race" gap identified in `logout-investigation.md` §2 as a free side effect of the same fix,
without any Discard-specific logic — worth stating plainly since it means this one guard closes
*both* directions named in the prior document's finding, not just the Logout-specific one.

---

## 3. Does This Fully Close the Vulnerability Class, or Only the Two Named Functions?

**Traced further, per this document's own mandate to design the fix concretely rather than just
confirm the two named sites — one adjacent, same-shaped instance found on the *pull* side, not
originally scoped by #1e, flagged here rather than silently expanded into an implementation.**

### `pullRemoteAttempts` — an internal inconsistency between its own two identity reads

`pullRemoteAttempts` (`storage.js:670-734`) resolves `session` once, at its own top
(line 673), and uses `session.user.id` twice — as the query filter (line 682) and to tag every
newly-inserted row's `ownerId` (line 711). Both of those are internally consistent with each
other. **But its final step, advancing the watermark, does not reuse that same `session`:**

```js
await savePreferences({ ...prefs, lastPulledAt: maxUpdatedAt })   // storage.js:731
```

`savePreferences` (`storage.js:198-201`) calls `resolveIdentity()` **independently** — a brand-new
`getSession()` call, not the `session` object `pullRemoteAttempts` already resolved several awaits
(and one full network round-trip to `puzzle_attempts`) earlier. If the live identity changes
between `pullRemoteAttempts`'s own top-of-function resolution and this final call — the same class
of window the two named push functions have, just inside a pull instead of a push — the watermark
gets written into a **different** identity's `preferences` record than the one whose attempts were
actually just inserted. Concretely: Account A's pull inserts A's attempts correctly (tagged
`ownerId: A`, using A's own already-resolved `session`), but if B's session is live by the time
`savePreferences` runs, **B's `lastPulledAt` watermark advances based on A's pull results** — B's
own next pull would then incorrectly treat everything up to that timestamp as already-fetched and
silently skip it. This is a quieter failure mode than the push-side bug (a silent, delayed
*omission* rather than an immediate visible corruption), but it's the identical root cause:
identity/session resolved more than once within one logical operation, with no guarantee the two
resolutions agree.

### `syncPreferences`'s own pull branch — the same shape, narrower window

`syncPreferences` (`storage.js:324-364`) resolves `identity` once at the top (line 327) and uses it
to read `local` (line 328). Its pull branch, several lines later, does an **independent**
`getSession()` call (line 342) and uses `session.user.id` for the remote `SELECT` filter
(line 348) — but writes the result back via `savePreferencesFor(..., identity)` (line 354),
**reusing the earlier `identity` variable, not `session.user.id`**. Same mismatch shape as above,
narrower window (a handful of `await`s apart within one function, versus a full network
round-trip), same consequence if it fires: a pulled remote row lands in the *wrong* identity's
local record.

### Scope call, not a decision made here

Both of these are the same underlying pattern as #1e's two named functions, surfaced by tracing
the fix rather than independently investigated end to end (their downstream consequences —
watermark skew, misattributed local pull data — were not traced as exhaustively as §1/§2 traced the
two push functions). **Flagging for a scope decision, not silently folding into this fix's
implementation:** whoever builds #1e's fix should decide whether to close these two pull-side
instances in the same pass (same root cause, arguably same PR) or track them as a distinct,
explicitly-scoped follow-up. Recommend the former, since the fix shape is identical (pin the
identity once, thread it through, compare before the write/return) and leaving them open would
mean Logout's blocking precondition is only half-addressed — a same-page-load `A → B` transition
racing a pull is exactly as reachable as one racing a push.

---

## 4. Interaction With Already-Shipped, Already-Tested Behavior

Checked against every existing test file that exercises `updatePreferences`/`syncPreferences`/
`pushPreferencesIfPossible` (`storage.preferencesPush.test.js`, `storage.preferencesSync.test.js`,
`storage.preferencesOutOfOrder.test.js`) and the attempts-side namespacing tests
(`storage.identity.test.js`): **every existing test uses a single, unchanging mocked identity
within each individual test case (`sessionOf('acct-1')` throughout, no mid-test identity switch).**
Adding `if (session.user.id !== identity) return` (or the attempts-side equivalent) cannot affect
any of them — the guard only ever fires when the two values *disagree*, and none of today's tests
construct that disagreement. **No regression expected in the existing suite**, though this should
be confirmed by actually running it once the fix lands, not assumed from this read-through alone.

**One worth flagging precisely:** `storage.identity.test.js`'s first test (lines 72-102) switches
`mockGetSession`'s resolved value from guest to `'acct-1'` partway through, immediately after an
un-awaited `recordAttempt(...)` call whose own fire-and-forget push is still in flight at that
point. This test's assertions never check the `synced` flag or the mocked `insert` call's
arguments, so it cannot currently detect whether that in-flight push's own `getSession()` call
happens to resolve *after* the mock switches to `'acct-1'` — which, if it does, is a live,
if accidental, real-time demonstration of exactly the bug this document investigates, already
present in the test suite and undetected simply because nothing asserts on it. Worth confirming
directly (not assumed here) whether this timing is actually reachable in that test today, since if
it is, it's informative evidence this bug isn't purely theoretical even in the existing,
already-shipped test environment — and it means adding the guard could very plausibly *change*
that test's incidental behavior (silently, since nothing asserts on it either way) rather than
leave it untouched. Recommend checking this specifically when the fix is verified, not before.

---

## 5. Verification Plan

**Level 1 — deterministic unit test, controlling the race explicitly rather than relying on
incidental timing** (same technique already established in
`storage.preferencesOutOfOrder.test.js`: a manually-resolved mock promise, not a real timing race):

- Mock `getSession` to return a pending promise for the racing push specifically; resolve it with
  a *different* identity's session only after the write-initiating call (`recordAttempt`/
  `updatePreferences`) has already returned and captured its own pinned identity/`ownerId`.
- Assert the mocked `insert`/`upsert` function is **never called** for that racing push (the
  strongest, most direct assertion — proves the guard aborts before any network call, not just
  after).
- Assert the original identity's local record is left `synced: false`, untouched.
- Assert the second identity's local/mocked-remote state is completely unaffected (for
  preferences: still whatever it was before, not overwritten by the first identity's stale
  values).
- A companion test confirming the **non-racing** case still succeeds normally (mock never
  switches identity) — guards against a guard that's too aggressive and breaks the ordinary path.
- If §3's pull-side instances are fixed in the same pass: equivalent tests for
  `pullRemoteAttempts`'s watermark write and `syncPreferences`'s pull-branch write, same
  controlled-race technique.

**Level 2 — live verification against the real Supabase project, two real accounts, matching this
codebase's established pattern** (per CLAUDE.md's Test Fixtures section and the
already-established real-`@supabase/supabase-js`-client-swap technique used for the
theme/preferences cross-device verification, 2026-09-12): mint two independent real sessions (the
existing `TEST_FIXTURE_KEEP` account plus one fresh throwaway, or two throwaways), deliberately
delay one account's push (e.g. a controllable `fetch` wrapper, mirroring
`storage.adoption.realSessionFixture.test.js`'s own `global: { fetch }` technique) until after the
live client has switched to the second account's session, and confirm live, server-side: the first
account's data never lands under the second account's `profile_id`, and the first account's local
row is still retryable. **This requires Logout to actually exist to construct the real scenario
end to end** (or a hand-rolled two-client simulation of the race without a real logout button, the
same substitution already accepted for the cross-device preferences verification) — flagged as a
live-write step needing its own before-not-after confirmation when build/verification work starts,
per the standing rule, not performed as part of this investigation.

---

## 6. Open Questions / Risks

1. **Scope decision on §3's pull-side instances** — same root cause, not originally named by
   #1e's blocking-bug description, needs an explicit call on whether they're fixed in the same
   pass. Recommend yes, per §3's reasoning.
2. **Whether the existing `storage.identity.test.js` test at lines 72-102 is currently, silently
   exercising this exact race** — worth confirming directly when the fix is verified (§4), not
   before; low risk either way (the fix should only make an already-questionable interleaving
   inert, not break a real assertion).
3. **This fix does not address, and does not need to address, the mid-puzzle-attempt gating
   question from `logout-investigation.md` §5, item 3** (Logout button needing the same
   `actionsDisabled`/`puzzleAttemptInFlight` treatment Login/Create Account already have) — that
   remains a separate, UI-level piece of Logout's own scope, complementary to this storage-level
   guard, not a substitute for it or substituted by it.
4. Minor: once this guard exists, a mismatched push becomes a **silent** no-op, identical in
   observable shape to an ordinary offline/failed push (`synced: false`, retried later). Worth a
   spec-time decision on whether this specific rejection reason is worth distinguishing in any
   future debug logging — not a correctness concern, since the existing retry mechanism already
   handles it correctly either way, just flagging that "why didn't this sync" would look identical
   for both causes if anyone ever needs to debug it.

### Production Supabase / live-write scope check

Per standing rule, flagging explicitly: **this investigation required no live writes and proposes
none.** The RLS-policy claim in §1 was verified by reading the actual migration SQL, not a live
query. Everything else is client-side code tracing (`storage.js`) and design reasoning about a fix
that has not been implemented. Level 2 of the verification plan (§5) is explicitly named as
requiring a live write against two real accounts once build/verification work actually starts —
not performed here, and needing its own before-not-after confirmation per the standing rule.

### Recommendation on Logout (#2)'s blocking status

**Unblock condition, stated plainly per this document's purpose:** Logout (#2) should remain
blocked until at minimum the two guards in §2 (`pushAttemptIfPossible`, `pushPreferencesIfPossible`)
are built and verified per §5 Level 1. Given how small and low-risk both fixes trace out to be —
one line each, no new parameters, no schema change, reusing data/parameters that already exist —
this should not be a significant addition to Logout's own timeline. The §3 pull-side instances are
a recommended-but-not-strictly-required companion fix for the same PR; if deferred instead, Logout
should not be considered fully unblocked until they're tracked as an explicit, named follow-up
rather than silently dropped.
