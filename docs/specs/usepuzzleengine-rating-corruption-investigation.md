# Investigation: `usePuzzleEngine` First-Boot Rating Corruption (Backlog #1d, blocking, oldest open item)

Status: **Findings only — no code changes, no commits, no writes to Supabase (local or
production).** For review before scope is locked. **Addendum (2026-09-14) below resolves both open
questions from §5 empirically/via exhaustive artifact search.**
Date: 2026-09-14 (original); addendum same day

Prerequisite reading (per the prompt): `CLAUDE.md`'s existing 🚩 BLOCKING PRECONDITION entry
(storage-partitioning section) and the commit it cites (`041e116`, "feat: first-boot legacy-data
adoption routine (Commit 3/4, storage partitioning)") — read in full, not just CLAUDE.md's summary
of it. That commit message is the actual origin of every claim CLAUDE.md repeats; it explicitly
labels the finding a "KNOWN, SERIOUS, NOT-YET-FIXED GAP... traced precisely after this commit
landed, correcting an EARLIER, WRONG 'narrow and self-healing' characterization" — i.e., this note
has already been revised once before, by the same process this investigation is now repeating.
That history is itself a reason to re-derive rather than inherit a third time.

**Bottom line up front:** the core mechanism — `usePuzzleEngine`'s boot effect firing before
`App.jsx`'s, deterministically, and the first puzzle on any legacy-data device therefore being
selected from the wrong (defaulted) rating band — is **reconfirmed exactly as stated**, unchanged
by #1e/#1f/#1g. But re-deriving the *downstream* claim — that committing that first puzzle "either
way" permanently corrupts the persisted `rating` field — turns up a real correction: that consequence
depends on a SEPARATE, much narrower race (`commitAttempt`'s own later profile read vs. adoption's
write) that the original analysis treated as certain but that concrete timing reasoning here shows
is not. The wrong-band selection is certain and universal; the permanent-rating-corruption is real
but rare in ordinary human play. Neither #1e, #1f, nor #1g touches this bug's mechanics — confirmed,
not assumed — but #1g's new `pullProfileStats()` does touch the same `rating` field and, if this
bug's rare corruption case ever fires, would faithfully propagate the corrupted value rather than
correct it. Full detail below.

---

## 1. Exact Failure Mechanics (re-derived, not inherited)

### 1a. Effect-registration order — reconfirmed against the CURRENT code

`src/App.jsx:30-52`: `usePuzzleEngine()` is the first call inside `App()`'s body, before any of
`App`'s own `useState`/`useEffect` calls. `src/hooks/usePuzzleEngine.js:357`:
`useEffect(() => { loadPuzzle() }, [loadPuzzle])` is the hook's only effect, registered during that
call. `App.jsx`'s own boot effect (`useEffect(() => {...}, [loadAndApplyPreferences])`, line 144) is
registered strictly later in the same render, since it's a later line in `App()`'s own body. React
fires passive effects in registration order within a component tree on a given commit — this is a
language/library-level guarantee (`useEffect` ordering), not a timing race. **Reconfirmed: `usePuzzleEngine`'s
effect callback is guaranteed to be invoked before `App`'s boot effect callback, on every mount, with
zero exceptions** — this part of the original note is exactly correct, and unchanged by anything
#1e/#1f/#1g added: none of those three touched `App.jsx`'s hook-call order or added any hook call
before `usePuzzleEngine()`. #1g added one new `import` and one new line inside `runSyncSequence`
(itself inside a `useCallback`, not a new effect, registered where the existing login-trigger effect
already was) — no change to registration order at all. Confirmed by direct re-read of the current
file, not assumed from the prior claim still being true.

### 1b. What "guaranteed to fire before" actually buys you — and what it doesn't

Registration order only guarantees which effect **callback starts running first**. Both `loadPuzzle()`
and `boot()` are async functions invoked (not awaited) from their effect callbacks — React does not
wait for either to finish before firing the next one. What happens after that is a genuine race
between two async chains, and the CURRENT code's specific shape of that race is worth tracing
precisely, because the two claims this investigation was asked to check (band selection vs. rating
persistence) turn out to depend on **two different sub-races**, not one:

**Race A — `loadPuzzle`'s `getProfile()` read vs. `adoptLegacyDataIfSafe`'s write (decides band
selection).** With `VITE_ENABLE_ACCOUNT_SYNC` off (today's actual production configuration — see §2
for why this specific configuration matters), both `resolveIdentity()` (inside `getProfile`, on
`loadPuzzle`'s side) and `boot()`'s own identity resolution short-circuit to `GUEST_IDENTITY`
synchronously, with no network call. Tracing the actual microtask/IndexedDB sequencing concretely
(both sides share the same module-level `dbPromise` cache in `storage.js`, so both end up awaiting
the *same* underlying `indexedDB.open()` call): `boot()`'s path to `adoptLegacyDataIfSafe`'s own
`openDB()` call has **zero** intervening `await`s before it (the flag-off branch has no await at
all), so it attaches to the shared `dbPromise` in the same synchronous tick React fires effects in.
`loadPuzzle`'s path to `getProfileFor`'s own `openDB()` call goes through `getProfile()` →
`await resolveIdentity()` first — one extra microtask hop — so it attaches to `dbPromise` slightly
*later*. This means **adoption's side is actually first in line** when the database finishes
opening, a detail the original note never traced this precisely. It doesn't matter for the outcome,
though: once the DB is open, `adoptLegacyDataIfSafe` still needs **four more sequential, separately-
awaited IndexedDB reads** (`getLegacyRecord` profile, `getLegacyRecord` preferences,
`getLegacyThemeStatsEntries`, `getRawAttempts`) before it can even evaluate `hasLegacyData`, let alone
open the write transaction — while `loadPuzzle`'s side needs exactly **one** more read
(`getProfileFor`'s own `.get(identity)`) before `getProfile()` resolves and `nearestBands(profile.rating)`
runs. Being first in the queue to open the DB does not matter when the ensuing workload is four
reads-then-a-write versus one read. **Reconfirmed, by a more precise route than the original note
took: on every legacy-data device's first boot, the first puzzle is selected using the current
module's `DEFAULT_PROFILE` (`rating: 1200`, from `src/utils/rating.js`), not the user's real
historical rating.** This is what "still-defaulted rating band" concretely means: `nearestBands(1200)`
→ home band `1200-1399.json` (`bandForRating`'s `Math.floor(1200/200)*200`), regardless of what the
user's actual rating would have been once adopted.

**Race B — `commitAttempt`'s SEPARATE, LATER `getProfile()` read vs. adoption's write (decides
whether the persisted rating field itself gets corrupted) — re-derived, and the finding here differs
from the original note.** `commitAttempt` (`usePuzzleEngine.js:200-230`) only runs once the user has
actually attempted the puzzle — a wrong move, a completed correct sequence, or a Hint press — never
at mount. Its own `getProfile()` call (line 208) is a **fresh, independent** read, unrelated to the
snapshot `loadPuzzle` already used for band selection. `updateRating(profile.rating, puzzle.rating,
solved)` is computed from *whatever this read returns*, and `recordAttempt` (`storage.js:868-912`)
always persists `rating: newRating` verbatim — it never re-derives rating from its own separate
profile read, which affects only the totals/streak counters (confirmed by direct re-read: `updated.rating
= newRating`, unconditionally, in every branch). So the question of whether the persisted rating gets
corrupted reduces entirely to: **does `commitAttempt`'s read, at the moment it actually happens,
still see the stale/defaulted profile, or has adoption's write already landed by then?**

The original commit message (`041e116`) treated this as settled the same way as Race A — "either way
the wrong ratingDelta is stored." Tracing it concretely shows that's a different race with a
different likely outcome: adoption's entire remaining chain (four sequential local IndexedDB reads
plus one write transaction, with the flag off — no network involved anywhere in this sequence) is
pure local I/O, completing on any real browser in on the order of single-digit-to-low-double-digit
milliseconds after mount. `commitAttempt`, by contrast, cannot run until the user has actually done
something — seen the board, decided on a move, dragged or tapped a piece, or pressed Hint — which
for a genuine human is realistically several hundred milliseconds at the very fastest (an
instantly-recognized one-move mate), and normally low seconds. **In ordinary human play, adoption's
write is very likely to have already landed by the time `commitAttempt` reads — meaning the
persisted rating is likely computed correctly, not corrupted, contradicting the original note's
"either way" framing.** The realistic ways `commitAttempt`'s read could *still* lose this race: an
automated script or test driving the board at inhuman speed (this project's own live-verification
scripts do exactly this kind of fast, scripted interaction), an unusually slow or contended device,
or (least likely, but worth naming) an extremely fast human response to a one-move mate. This is
stated as a re-derived correction, not a re-run empirical measurement — settling it definitively
would need an instrumented timing test, which is implementation/test work, out of this
investigation-only pass's scope (see §5).

### 1c. Reachable only with legacy local history — confirmed, not assumed

`adoptLegacyDataIfSafe`'s first four lines run on *every* boot regardless of whether there's
anything to adopt, but if `hasLegacyData` is false, it returns immediately (`if (!hasLegacyData)
return { adopted: false, deferred: false }`) with no write at all. For a genuinely fresh
identity, `getProfile()` returning `DEFAULT_PROFILE` **is correct** — a new account or guest should
start at 1200 — so there is no competing correct value to race against, and no bug. **Legacy local
history is essential to this bug, not incidental to the scenario that surfaced it.** Separately
confirmed: the "deferred" sub-case (a stranded real-account session that resolves to `GUEST_IDENTITY`
but has legacy attempts with a raw `synced === true` marker) does not create a *different* race —
it just means adoption doesn't write anything *this* boot either, so `getProfile()` still returns
`DEFAULT_PROFILE` for that boot's first puzzle for an unrelated reason (nothing was adopted, not "the
adoption lost a race"). This sub-case requires a legacy attempt row that was, at some point in the
past, written by a session-gated push or Merge — which (see §2) requires `VITE_ENABLE_ACCOUNT_SYNC`
to have been on for that device at some prior point. Available evidence (§2) suggests this has never
happened for any real production device, making the deferred branch likely unreachable in practice
today — but this is inference from absence of evidence, not a repo-verifiable fact, and is stated
that way rather than asserted as certain.

---

## 2. Blast Radius

**Puzzle-difficulty mismatch (certain, per Race A): magnitude is `|true_rating − 1200|`, not a fixed
number.** A user whose real rating is near 1200 sees almost no mismatch; a strong player at, say,
2200 gets shown puzzles from the `1200-1399.json` band — roughly 800-1000 rating points too easy —
on exactly one puzzle. This is a real UX defect (a jarring first impression, not a data-integrity
one) and **self-limits to exactly one puzzle, not compounding**: `loadNextPuzzle` is the same
`loadPuzzle` function, and by the time a user can reach "Next Puzzle" they have necessarily already
interacted with puzzle #1 (real human time elapsed) — by then adoption has certainly completed (same
timing argument as Race B, but now working in the fix's favor), so puzzle #2's own `getProfile()`
call correctly reads the adopted profile. A **fresh subsequent boot** (a later day, a page reload)
never re-hits this at all: adoption is idempotent and already consumed the legacy data on boot #1,
so `hasLegacyData` is false on every later boot and `getProfile()` correctly reads the
already-namespaced record immediately, no race possible. **One-time, one-puzzle, non-compounding —
confirmed, not assumed, by tracing exactly when `hasLegacyData` can next be true for the same
device.**

**Rating persistence corruption (real, but narrower than "always," per Race B): bounded delta,
unbounded discontinuity if it happens.** `updateRating`'s own `delta` is mathematically bounded to
roughly ±24 regardless of how wrong the baseline is (`K_FACTOR = 24`, `expected` strictly in `(0,1)`,
so `24 * (actual − expected)` is strictly in `(−24, 24)`) — a single bad attempt never swings the
number by a large amount on its own. The actual damage, *if* Race B is lost, is that the persisted
`rating` field becomes `Math.max(100, 1200 + delta)` ≈ 1176–1224 — a full, silent reset that
discards the entire prior rating history, not a small nudge. So: the per-attempt arithmetic error is
always small; the baseline discontinuity it gets applied to, if this narrow race is lost, is
potentially the user's entire accumulated rating history. This does **not self-correct on a later
boot** — nothing in the shipped app ever re-derives a device's local `rating` field from anything
else once it's written (confirmed by grep: no local recompute-from-attempts function exists
anywhere in `src/`, same finding #1g's investigation already made for a related reason). It is
permanent locally unless and until something externally overwrites it — see §4 for exactly what
that would take and what it would and wouldn't fix.

**Has any account ever actually had `VITE_ENABLE_ACCOUNT_SYNC` enabled in the past? Checked, not
assumed — inconclusive from the repo alone, stated precisely rather than guessed.** `.env` is
git-ignored (confirmed: listed in `.gitignore`) and there is no `.env.example`, deployment workflow,
or other committed artifact recording the flag's historical value on whatever hosts the actual
production deployment — this repo has no visibility into that, and there is no committed evidence
either way. What *is* confirmed: the flag is `'true'` for the entire local test suite
(`vitest.config.js`) and has been used locally, repeatedly, this session, to create and exercise a
real Supabase account (`TEST_FIXTURE_KEEP`) — but that account was created via Create Account (no
pre-existing legacy local history involved at all), so none of that activity could have exercised
this specific race regardless of the flag's state. Whether the flag was ever live on an actual
end-user's device with legacy local history is not something this investigation can settle from the
code or git history alone — flagged as an open question for Tiggs in §5, not assumed resolved either
way.

---

## 3. Fix Design

Per the prompt's instruction not to assume a single obvious shape:

### (a) Gate `usePuzzleEngine`'s first `loadPuzzle()` call on a "ready" signal from `App.jsx`

Have `App.jsx` compute a boolean once its boot sequence (session resolve → adopt → preferences load)
has completed, and pass it into `usePuzzleEngine` (currently a zero-argument hook — this changes its
public contract) so its boot effect becomes `useEffect(() => { if (!ready) return; loadPuzzle() },
[ready, loadPuzzle])`.

- **Eliminates Race A entirely, structurally** — not by winning the race faster, but by removing it:
  `loadPuzzle`'s first `getProfile()` call simply cannot run until adoption has already returned.
  This also eliminates Race B as a side effect: if `loadPuzzle` itself doesn't start until adoption
  is done, `commitAttempt`'s later read (which happens even later, after human interaction) is
  certainly also reading the correct, already-adopted profile. One structural fix closes both
  consequences, not just the one it was aimed at.
- **Tradeoff:** introduces a new cross-hook dependency where none currently exists — `usePuzzleEngine`
  is presently fully self-contained (no props at all). `App.jsx` must compute this correctly for the
  overwhelmingly common case (no legacy data, flag off or on) without needlessly delaying puzzle
  load — the boot sequence is fast when there's nothing to adopt, but this is a real, permanent,
  small delay added to every single boot, in exchange for closing a bug that (per §2) is otherwise a
  one-time, single-device, mostly-cosmetic event for most users and a rare corruption event for a
  minority.

### (b) Give `updateRating`/`recordAttempt` a retroactive correction path

Detect, after adoption completes, whether an attempt was recorded during the narrow window before
it landed, and retroactively recompute that attempt's `ratingDelta` and the resulting `profile.rating`
against the now-correct baseline.

- **Does not address the wrong-band-selection consequence at all** — by the time any correction
  could run, the wrong puzzle has already been shown and solved/failed; a retroactive fix only
  patches the `rating` field's persisted value after the fact, not the difficulty-mismatch experience
  itself.
- **Architecturally harder than it looks:** there is currently no marker recorded on an attempt row
  distinguishing "computed under a race" from "computed normally" — building one means either
  timestamp-comparing against adoption's own completion time (adoption doesn't currently record when
  it finished) or some other new bookkeeping, plus handling the (vanishingly rare, but not provably
  impossible) case of *more than one* attempt landing inside that narrow window.
- **Strictly narrower in what it fixes** than (a), for meaningfully more implementation complexity.

### (c) Combination

Given (a) already closes both consequences structurally, a combination adds (b)'s complexity for no
additional coverage. Not recommended as "belt and suspenders" here — there's no residual gap (a)
leaves open that (b) would need to catch.

### Recommendation (Tiggs's call, not decided here)

**(a) is the stronger direction** — it is a structural fix (removes the race) rather than a
palliative one (detects and patches a specific symptom of it), and per the trace above it closes
both the certain consequence (Race A) and the rare one (Race B) with a single change. (b) is
strictly weaker (misses the wrong-band UX issue entirely) and meaningfully more complex to build
correctly. A rejected alternative worth naming explicitly: making `adoptLegacyDataIfSafe`'s own reads
faster (e.g., one combined transaction instead of four sequential ones) so it's more likely to win
the race — this doesn't eliminate the race, it only shifts the odds, and per Race A's own trace
above, adoption is *already* first in line to open the database; the remaining gap is structural
(four reads vs. one), not something a faster implementation of the same shape reliably closes.

### What would prove a fix works

The core claim to test is "the first puzzle after a legacy-data boot is selected using the adopted
rating, not the default" — this requires seeding pre-partitioning legacy data with a known
non-default rating and observing which band the first `loadPuzzle()` call selects from. **Adversarial
case:** confirm the *current* (pre-fix) code selects from the wrong band under this exact seeded
condition (proving the test actually exercises the race, not a false positive), then confirm the fix
selects correctly, then temporarily revert the fix and confirm the test fails again for the traced
reason — the same revert/confirm-fail/restore pattern used throughout this project's other fixes.
Test-layering note, flagged rather than resolved: this bug spans two components
(`usePuzzleEngine`/`App.jsx`) the way #1g's own bug spanned `LaunchOverlay.jsx`/`App.jsx` — and that
investigation found this repo has no precedent for a full-`<App/>`-level test (only
`LaunchOverlay.migration.test.jsx` exists, and it tests `LaunchOverlay` in isolation). Whether to
build a first App-level test, or restructure the fix to be testable by giving `usePuzzleEngine`'s
"ready" gate a seam that can be exercised directly (e.g., a hook-level test with a controlled ready
value), is a real test-architecture decision for whoever builds this — named here, not decided.

---

## 4. Scope Boundary

**No touch to #1e/#1f/#1g's own code required.** `usePuzzleEngine.js` never calls anything in
`storage.js`'s push/pull guards or `pullProfileStats`, and touches `LaunchOverlay.jsx` not at all.
The fix in §3(a) touches `App.jsx` (to compute and pass a readiness signal) and `usePuzzleEngine.js`
(to accept and gate on it) — neither file's #1e/#1f/#1g-related code paths (`runSyncSequence`,
`pushAttemptIfPossible`, `pullRemoteAttempts`, `pullProfileStats`, `syncPreferences`) need to change
at all. Confirmed independent, not assumed.

**Does #1g interact with this bug's mechanics? Checked concretely, per the prompt's explicit
instruction not to assume independence — the answer is: no causal interaction in production today,
but a real, worth-naming propagation path if the bug's rare corruption case ever fires.**
- `pullProfileStats()` only runs inside `runSyncSequence`, which only runs once `sessionStatus ===
  'valid'` — and that transition is set inside the SAME `boot()` function, strictly AFTER `await
  adoptLegacyDataIfSafe(identity)` already returned (`App.jsx:163-168`). So `pullProfileStats()`
  cannot possibly run before adoption completes; it is causally sequenced after both races described
  in §1, not racing either of them. It also only runs at all when `ACCOUNT_SYNC_ENABLED` is true —
  which, per this very blocking precondition, is not the case in production. **No interaction occurs
  in the actual current deployment, because the two conditions that would let them interact (the
  flag being on, and legacy data existing) are mutually exclusive by policy.**
- But `pullProfileStats()` *does* write the same local `profile.rating` field this bug corrupts, and
  it does so unconditionally (by design, per #1g's own investigation — confirmed correct for its own
  purpose). If this bug's rare Race-B corruption ever did fire on a device that *later* gets a real
  account (Create Account, Merge, with the flag eventually turned on) — the corrupted attempt row's
  `ratingDelta` would be migrated verbatim by `migrateGuestDataToAccount` (already traced in
  #1g's own investigation: raw per-attempt deltas are pushed as-is, no revalidation), summed
  permanently by `recompute_stats()` server-side, and then `pullProfileStats()` would faithfully pull
  that now-corrupted server value back down — round-tripping the corruption, not fixing it. **This is
  a genuine, previously-unstated connection between #1d and #1g/Merge**: the flag being off during
  the *original* corruption event does not make that corruption safe forever — it only defers the
  moment it can become permanent and server-side to whenever that same device's user later creates an
  account and Merges. Worth flagging plainly: fixing #1d does not need to touch #1g's code, but until
  #1d is fixed, a very rare local corruption event, if it already happened on some device before this
  investigation, remains a live landmine for that device's *eventual* Merge, not something #1g's own
  live-verified fix protects against (that fix was never designed to detect or correct bad input from
  before it ran, only to correctly pull down whatever the server has).

**Does fixing #1d fully clear the way to enable `VITE_ENABLE_ACCOUNT_SYNC` for legacy-history
accounts, or are there other reasons to keep it off?** Checked, not assumed: a grep of `docs/specs/`
and `CLAUDE.md` for other stated reasons the flag should stay off turns up none — every other
mention of the flag either describes its mechanics (default-off convention, "zero Supabase traffic"
invariant) or points back at this exact bug. `Sharpin_Spec_AccountSync.md`'s own accepted-risks
section (§8) lists unrelated risks (sequence entropy, free-tier auto-pause, LWW conflict resolution,
rate-limit IP-spoofing) that are already-accepted, not blocking, and not about legacy-data corruption
at all. **No other blocking reason was found in this repo** — but this investigation cannot rule out
a reason that exists only outside the repo (e.g., an operational or business decision never written
down here), so this is stated as "nothing found," not "nothing exists."

---

## 5. Open Questions / Risks

- **Race B's real-world frequency is reasoned from timing principles, not measured.** This
  investigation is confident in the *relative* ordering argument (adoption's local-only chain is
  fast; human interaction is slow) but has not built or run an instrumented test to confirm it
  empirically — appropriately, since that would be test/implementation work outside this
  investigation-only pass. Whoever scopes the eventual fix should treat this as a claim to verify
  early, not a settled fact to build on unchecked — the same caution this document is itself applying
  to the prior note.
- **Whether the deferred/stranded-account sub-case (§1c) is truly unreachable in production** depends
  on whether `VITE_ENABLE_ACCOUNT_SYNC` was ever live for any real device with legacy data — genuinely
  unknown from this repo alone (§2). If it turns out the flag *was* briefly live at some point, some
  currently-guest-looking devices could actually be in the deferred state, silently defaulting on
  every boot rather than the one-time pattern §2 describes for the common case — worth Tiggs
  confirming from whatever visibility exists outside this repo (hosting platform env-var history, if
  any).
- **The #1d/#1g Merge-propagation connection (§4)** means that if this bug's rare corruption case has
  *already* fired on some real device before today, fixing #1d now does not retroactively clean up
  that device's already-corrupted local `rating` — there is no way to distinguish a corrupted rating
  from a legitimately-low one after the fact, by design (this is the same "no correction path" the
  original note already flagged, re-confirmed here, not newly discovered). This is a pre-existing,
  irreversible risk for any device that already hit it, independent of whether or how #1d gets fixed
  going forward.
- **No production Supabase writes or live verification were performed or are needed for this
  investigation** — everything above is derived from direct code, schema, and git-history reads.
  Building and verifying the eventual fix will need this project's usual live-verification pattern
  (per §3's test section) before being called closed — **do not proceed on that without explicit
  confirmation**, per the prompt's own instruction, not started here.

---

## Addendum (2026-09-14): Diagnostic Follow-Up on §5's Two Open Questions

Diagnostic/measurement only — no code changes, no commits, no writes to production Supabase.
Nothing in this addendum touches CLAUDE.md; both parts below are exactly what was asked, no more.

### Part 1 — Was `VITE_ENABLE_ACCOUNT_SYNC` ever live against production?

**Full git history searched, not just current state:**
- `git log --all -S"VITE_ENABLE_ACCOUNT_SYNC"` (pickaxe search, every commit, only branch is
  `master`/`origin/master` — no other branches exist) returns exactly four commits, all already
  known: the storage-partitioning Commits 1 and 4, the Stage 3 backlog-#1 commit, and the ongoing-sync
  push-logic commit. Every actual line matching the string in the full diff history
  (`git log --all -p -G"..."`) is either (a) `vitest.config.js` setting it `'true'` for the local test
  suite, (b) `storage.identity.flagOff.test.js`'s own per-test override to `'false'`, (c) source/doc
  comments in `App.jsx`/`storage.js`/`CLAUDE.md` describing the default-off convention, or (d) this
  investigation's own text. **Nothing resembling a production or deployment-time value was ever
  committed.**
- **`.env` was never committed, at any point, in the entire project history** — confirmed by
  `git log --all --oneline -- .env .env.local .env.example` returning nothing at all, and by reading
  `.gitignore` **as it existed in the very first commit** (`0488023`): `.env`, `.env.local`, and
  `.env.*.local` were excluded from commit #1 onward. There is no window in this project's history
  where a committed `.env` could have leaked a real value either way.
- **`vercel.json` was read in full, both versions it ever had** (`git log --all --follow -p --
  vercel.json`): version 1 (initial commit) and version 2 (before deletion) both contain *only* a
  URL rewrite rule (`{"rewrites": [{"source": "/api/(.*)", "destination": "/api/$1"}]}`) — no `env`
  block, no environment-variable defaults, ever. It was deleted entirely in `a3cff7c` (July 29,
  2026), removing the old Claude-proxy API route — **months before backlog #1's Stage 3 (Sep 2026,
  `7d89a72`) even introduced this flag.** It is not possible for this file to have set the flag at
  any point in its existence, because the flag didn't exist yet when this file did.
- **The only GitHub Actions workflow in this repo** (`.github/workflows/refresh-puzzles.yml`) is a
  monthly Lichess puzzle-database refresh job — checkout, download, rebuild JSON chunks, commit. It
  sets no environment variables at all and has nothing to do with deployment or this flag.
- **No other deployment script, CI config, or `.env.example` exists anywhere in this repo.**

**What this investigation CANNOT verify, stated plainly:** whatever Vercel's dashboard actually has
configured for the live deployment's environment variables is not visible from this repo at all —
this investigation has no Vercel API access or credentials (consistent with this project's
established practice of not holding service-role-level credentials for anything). **Repo-side
evidence is exhaustive and entirely consistent with the flag never having been live in
production** — no contradiction to Tiggs's own confirmation was found anywhere in git history, and
none of the artifacts that *could* theoretically have carried a production default (a committed
`.env`, `vercel.json`, a CI workflow) ever did. This is "no evidence found, after an exhaustive
repo-side search" — not an independent, positive proof, since that would require access to Vercel's
own dashboard/audit log, which is Tiggs's alone to check (Vercel → Settings → Environment Variables
→ history/audit log, if Vercel retains one, or deployment logs showing the env var's resolved value
at each deploy).

**Answer to Question 1: Unconfirmable as an independent positive proof from this repo alone, but
every repo-accessible artifact is consistent with Tiggs's confirmation that it was never enabled —
no contradicting evidence of any kind was found. Not a "stop, real incident" finding.**

---

## Addendum (re-run, 2026-09-20): Race B measured via vitest/jsdom/fake-timers

**Replaces the deleted "Addendum (2026-09-14) ... Part 2."** That section claimed
Playwright/CDP-specific methods (fresh browser contexts, CPU throttling) this repo's toolchain does
not have — confirmed absent (`package.json` has no Playwright/Puppeteer dependency; CLAUDE.md itself
states no browser automation exists in this repo) — and was deleted in full rather than corrected.
Nothing below reuses any number from that deleted section. **Diagnostic/measurement only — no
changes to `src/`, no commits, no writes to Supabase (local or production). Not marked resolved
below; reported back for review, per instruction.**

**Tooling confirmed before choosing a method** (`grep -n "playwright|puppeteer" package.json` →
nothing; `package.json` devDependencies actually present: `vitest`, `jsdom`, `fake-indexeddb`,
`@testing-library/react`, `@testing-library/dom`): method used is vitest + jsdom + fake-indexeddb +
React Testing Library, rendering the REAL `usePuzzleEngine` hook (real `chess.js`, real puzzle-band
JSON via `import.meta.glob`, real `storage.js`) inside a small harness component that reproduces
`App.jsx`'s actual boot-effect body verbatim for the flag-off branch (`App.jsx:147-156`: `identity =
GUEST_IDENTITY` with zero intervening awaits, then `await adoptLegacyDataIfSafe(identity)`), and
preserves the same hook-call-before-boot-effect registration order `App.jsx` has. Interaction delay
is real elapsed wall-clock time (`await new Promise(r => setTimeout(r, ms))`), not
`vi.useFakeTimers()` — fake-indexeddb's own request scheduling runs on real timers/microtasks, and
faking them risked stalling it or requiring blind assumptions about its internals. Test file:
`src/hooks/usePuzzleEngine.raceB.realtiming.test.jsx` — **left in place, not deleted, not
committed**, independently rerunnable via `npx vitest run
src/hooks/usePuzzleEngine.raceB.realtiming.test.jsx`. Do not delete without confirming with Tiggs
first.

**Controls run first, both required and both checked (not assumed):**
- **Positive control** (no legacy data, genuinely fresh guest): correctly read back
  `1176 ≤ rating ≤ 1224` after Hint — 1200 is the *correct* answer here, confirming the harness
  produces a sane result in the uncontested case.
- **Adversarial control** (`HarnessNoAdoption` — `adoptLegacyDataIfSafe` never called at all, legacy
  profile at rating 1800 seeded but never adopted): correctly read back `1176 ≤ rating ≤ 1224` —
  the CORRUPTED band. This is the control the deleted addendum never had: it proves the classifier
  and harness can actually detect and report corruption when the underlying condition is genuinely
  present, rather than the "zero corrupted" result below being a silent false negative from a broken
  or unreachable test.

**Measured mechanism (the actual boundaries, not a restated conclusion):** `adoptLegacyDataIfSafe`'s
own chain (4 sequential legacy reads + 1 write transaction, `storage.js:1123-1171`), timed directly
inside the harness from immediately before its call to immediately after it resolves, completed in
**0.5–15.5ms** across every trial in this environment (fake-indexeddb is in-memory, pure JS). By
contrast, `usePuzzleEngine`'s own `loadPuzzle()` — which must fully finish (its own `getProfile()`
read, `import.meta.glob`'s dynamic import of the puzzle-band JSON, weighted puzzle selection,
`chess.js` setup) before `status` becomes `'solving'`, the earliest point Hint is even pressable —
took **62–92ms** to reach `'solving'` across every trial. **Because adoption's write consistently
finished (0.5–15.5ms) well before `loadPuzzle` itself finished (62–92ms), the race was already
decided in adoption's favor before Hint ever became pressable — in every trial, including the
theoretical floor (Hint pressed with zero added delay, the earliest the app's own code permits any
commit at all).**

**Results — 14 real trials (5×0ms, 3×150ms, 3×800ms, 3×3000ms), zero corrupted:** every trial, at
every delay including the 0ms floor, read back `1776 ≤ rating ≤ 1824` (correct). Full per-trial
timings (`mountToReadyMs`, `mountToPressMs`, `commitDurationMs`, `adoptionDurationMs`) are in the
test's own `console.log` output, reproducible by rerunning the file — not transcribed as a table
here to avoid the previous addendum's mistake of presenting numbers as a finished artifact rather
than pointing at the source that produced them.

**Answer to Question 2, stated at the actual scope this measurement supports — narrower than the
deleted addendum claimed:** In this specific environment (Node + jsdom + fake-indexeddb under
vitest), no tested interaction speed — including the code's own absolute floor, no human involved —
ever landed inside Race B's window, because `loadPuzzle`'s own completion time in this environment
(dominated by `import.meta.glob`'s dynamic import of puzzle JSON, not by IndexedDB) already exceeds
adoption's write time by roughly an order of magnitude. **This is empirical support for, not proof
of, the original investigation's "narrow, not ordinary-human-reachable" classification** — it adds
one more environment that failed to produce the corrupted outcome, on top of the original static
trace. It explicitly does **not** prove the same holds in a real production browser: fake-indexeddb's
write speed and this environment's puzzle-JSON dynamic-import overhead (Vite/vitest's dev-time
module resolution under Node) are not representative of real browser disk I/O or network-fetched
chunk timing, and this repo has no tooling (confirmed above) to measure either of those for real.
**The honest scope of this result is "no evidence of Race B firing was found in the one environment
this repo's actual toolchain can exercise" — not "confirmed safe in production."**

**Does this change the severity classification or #1d's priority? No.** Race A (certain,
universal wrong-band selection on any legacy-data device's first puzzle) is entirely unaffected by
any of this and remains the dominant, certain argument for #1d's priority regardless of Race B's
outcome. This measurement modestly reinforces the existing "narrow" classification for Race B within
its own stated limits; it does not newly justify deprioritizing #1d, and the "no correction path once
it happens" permanence risk (§2) remains real for whatever residual probability exists in an actual
browser, which remains unmeasured.
