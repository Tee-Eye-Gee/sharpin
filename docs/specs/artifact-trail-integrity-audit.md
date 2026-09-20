# Artifact Trail Integrity Audit

Date: 2026-09-20
Status: **Audit only — no fixes, no deletions, no code changes, no commits, nothing resolved.**
Trigger: a fabricated "empirical" diagnostic (Playwright/CDP-style browser automation, CPU
throttling, a 15-trial timing table) was found in
`docs/specs/usepuzzleengine-rating-corruption-investigation.md`'s "Addendum (2026-09-14) ... Part
2," sitting untracked for 5 days with no determinable origin, and was deleted earlier this session.
This document is the requested full-corpus check of every other claim in `CLAUDE.md` and
`docs/specs/` against what the repo itself can actually corroborate.

**Method note, stated up front:** every "live-verified against production Supabase" (or live-DOM)
claim in this codebase is, BY THIS PROJECT'S OWN STATED PRACTICE, structurally unverifiable from
repo evidence — one-off verification scripts are deliberately never committed. That practice is
real and is documented in multiple places in this corpus. It means an entire large class of claims
below gets the verdict **unverified — no corroborating trace**, and that verdict is *not* a
euphemism for "probably fabricated" — it is stated as its own, distinct fact: this class of claim
cannot be distinguished from a fabricated one using repo evidence alone, one way or the other. Where
a claim's *content* (not just its live-verification framing) is independently checkable — a cited
file, a line number, a test count, a described code path, a tooling requirement — that was checked
directly and is reported with a real verdict, not folded into the blanket "unverified" bucket.

---

## Finding 0 — The originally-reported fabrication (context, already actioned)

`docs/specs/usepuzzleengine-rating-corruption-investigation.md`'s deleted "Addendum (2026-09-14) —
Part 2" claimed a second Vite dev server, "fresh browser contexts," and CPU throttling up to 100x,
producing a specific 15-row timing table. `package.json` has never included Playwright or Puppeteer.
This was deleted in an earlier turn this session, replaced with a real vitest/jsdom/fake-indexeddb
re-run (`src/hooks/usePuzzleEngine.raceB.realtiming.test.jsx`, still present, uncommitted). Included
here only as the calibration baseline for the rest of this audit — nothing further to do on it.

---

## Finding 1 — CLAUDE.md itself (not a scratch doc) contains the same species of claim, uncorrected

**This is the most significant finding of this audit**, because it sits in the actively-maintained,
committed, trusted file — not an untracked 5-day-old doc — and has survived multiple later edits to
the very same document without correction.

- `CLAUDE.md:23` (Test Fixtures section, added by commit `46fe981`, **2026-09-09**): *"A persistent
  test account exists in the LIVE Supabase project for **Playwright-driven, real-backend
  verification** across commits."*
- `CLAUDE.md:566` (Backlog #1g section, added by commit `adc4db5`, **2026-09-14**): *"on a
  brand-new **Playwright browser context** with empty IndexedDB — the real second-device condition,
  not simulated."*
- `package.json`/`package-lock.json` have **never**, at any point in git history, included Playwright
  or Puppeteer as a real (non-optional, non-peer) dependency — confirmed by `git log --all
  -S"playwright" -i -- package.json package-lock.json` and by direct inspection of every hit that
  string search returns (all are `@vitest/*` optional peer-dependency metadata, `"optional": true`,
  never installed by a normal `npm install`).
- **CLAUDE.md contradicts itself on this exact point**, and the contradiction is chronologically
  bracketed by both false claims: commit `69847b3` (**2026-09-12**, between the two Playwright
  claims above) added the line *"no browser automation exists in this repo"* to CLAUDE.md's
  theme/preferences section — still present today — as the explicit justification for using a
  different verification method. Three commits (2026-09-09, 2026-09-12, 2026-09-14) touched this
  exact topic and never reconciled the contradiction.

**Forensic wrinkle, reported precisely rather than concluded either way:** this machine's
`node_modules/playwright` directory physically exists, real (`playwright@1.63.0`, with Chromium +
`chromium_headless_shell` + `ffmpeg` browser binaries cached under
`%LOCALAPPDATA%\ms-playwright`), and its `package.json` file's mtime is **2026-09-14 09:49:23 -0400**
— i.e., real browser-automation capability *did* physically exist on this machine that morning,
roughly 17 minutes after commit `0f8bb67` (09:32:46) and about 4.5 hours before commit `adc4db5`
(14:07:29, the commit containing the "Playwright browser context" claim), and about 9 hours before
the fabricated Part 2 file's own mtime (18:43:52) the same day. However:
- `npm ls playwright` reports it as **`extraneous`** — it has never been in `package.json` or
  `package-lock.json` at any point, so it is invisible to anyone else who clones this repo and runs
  `npm install`, and it is covered by the blanket `node_modules/` `.gitignore` rule (not a
  deliberate, named ignore entry for it specifically).
- **No corroborating execution artifact exists anywhere**: no `playwright.config.*` file, no
  `playwright-report/` or `test-results/` directory, no `.trace.zip`, no npm install log from
  2026-09-14 survives (npm's own log retention had already rotated past that date by the time this
  audit checked). A raw, config-less script using Playwright's API directly wouldn't necessarily
  leave a report/trace behind, so this absence is suggestive, not conclusive.
- The 2026-09-09 claim (`CLAUDE.md:23`) **predates** the Playwright install by 5 days — at the
  moment that line was written, Playwright did not yet exist anywhere on this machine, full stop.
  That specific claim was false the moment it was written, regardless of what happened later.

**Verdict: internally-inconsistent AND contradicts-declared-repo-capabilities.** Both CLAUDE.md
claims describe a method this project's own declared, reproducible toolchain has never supported.
Whether real Playwright was ever actually invoked (for the #1g claim, the fabricated Part 2, or
neither) is genuinely unresolved — flagged for Tiggs's judgment, not concluded here.

---

## Finding 2 — A named, cited supporting artifact does not exist

`docs/specs/guest-merge-profile-migration-investigation.md` cites `scratch-migration-verify.mjs`
(repo root) as a still-existing, deliberately-uncommitted script backing its "reproduced live
against production Supabase twice" headline claim. This file:
- does not exist in the working tree (`ls`, `find` — nothing),
- was never tracked at any point in git history (`git log --all -- scratch-migration-verify.mjs` —
  empty),
- is not covered by any specific `.gitignore` entry (only the generic pattern set, nothing naming
  it).

**Verdict: unverified-no-trace, and weaker than similar claims elsewhere** — most other docs in this
corpus honestly phrase deleted one-off scripts in the past tense ("was deleted after running, not
committed"). This doc instead asserts present-tense continued existence of a specific, named file
that cannot be found by any method. Smaller in blast radius than Finding 1 (it's a citation, not a
claimed empirical method or result), but the same shape of problem: a specific, checkable detail
that doesn't survive a repo-level check.

---

## Finding 3 — Stale/incomplete count in CLAUDE.md's tech-stack section

`CLAUDE.md`'s "Tech stack" section states: *"7 tables, RLS-enforced on all of them (`profiles`,
`puzzle_attempts`, `theme_stats`, `profile_stats`, `preferences`, plus rate-limit ledgers
`verify_attempts` and `create_account_attempts`)."*

Direct inspection of `supabase/migrations/` shows **8** RLS-enforced tables exist, not 7:
`supabase/migrations/20260909160000_sanity_bound_checks.sql` creates `public.anomaly_log`
(`create table if not exists public.anomaly_log (...)`, line 34), enables RLS on it (line 45,
`alter table public.anomaly_log enable row level security;`), and adds an owner-only policy (line
47) — added by commit `8711626` (**2026-09-09**, "feat: add sanity-bound checks on
profile_stats/theme_stats writes"), which is itself referenced elsewhere in CLAUDE.md's "Current
task" section ("`anomaly_log`... a non-blocking, log-only sanity-check backstop"). The tech-stack
count line was simply never updated when that table was added.

**Verdict: internally-inconsistent (stale count)** — not a fabrication, a documentation-drift bug:
the same document names `anomaly_log` correctly elsewhere but undercounts it in the summary line.

---

## Finding 4 — Minor spec-internal drift (not a fabrication)

`docs/specs/Sharpin_Spec_AccountSync.md` §2 (original, 2026-08-19 draft) describes the identity
model as "real Supabase Auth identity... anonymous auth," while §5a (the as-built section) describes
the actual synthetic-email + `admin.createUser`/session-mint approach and explicitly says no
`signInAnonymously()` call is ever made. CLAUDE.md's own current tech-stack line already states the
corrected version accurately ("reached via a synthetic-email + session-mint pattern... not native
anonymous auth"), so the drift is confined to the spec file's own early section never being updated
to match its later section — CLAUDE.md was not misled by it.

**Verdict: internally-inconsistent, low severity.** Ordinary spec drift from an evolving design, not
a fabricated claim.

---

## Finding 5 — StrictMode nuance never stated (not a fabrication, but worth surfacing)

`src/main.jsx` renders `<StrictMode><App/></StrictMode>` via a single `createRoot(...).render()`
call, exactly as `CLAUDE.md`'s and `docs/specs/logout-investigation.md`'s "Gate Step 0" claim
describes (no `key` prop, no second render call — directly verified by reading the file). However,
neither doc mentions that `<StrictMode>` causes React 18 to mount→cleanup→mount every effect once in
**local dev only** (not production). The "boot effect fires exactly once per real page mount" claim
is accurate for production but not literally true during `npm run dev` — a real nuance neither doc
states.

**Verdict: corroborated claim, with an unstated caveat** — not a fabrication, but a gap worth
Tiggs's awareness since it touches the exact assumption `adoptLegacyDataIfSafe`'s "once per boot"
safety depends on.

---

## Full claim-by-claim table

Aggregated from direct audit (CLAUDE.md structural/numeric claims, git history) plus five
sub-audits, one per investigation-doc cluster, each independently checking commits via `git show
<hash> --stat` and diff-content spot-checks, not commit messages alone.

| # | Claim / Section | Verification method | Verdict | Notes |
|---|---|---|---|---|
| 1 | CLAUDE.md: 16 puzzle rating-band files | `ls src/data/puzzles/*.json \| wc -l` | **corroborated** | Exactly 16. |
| 2 | CLAUDE.md: "7 tables, RLS-enforced on all of them" | Read all `supabase/migrations/*.sql` | **internally-inconsistent** | Actually 8 (see Finding 3). |
| 3 | CLAUDE.md Test Fixtures: "Playwright-driven, real-backend verification" (line 23) | `package.json`/lock history, cross-ref line 566 and line ~600s "no browser automation" | **internally-inconsistent / contradicts-declared-capabilities** | See Finding 1. |
| 4 | CLAUDE.md #1g: "brand-new Playwright browser context" (line 566) | Same, plus node_modules forensic check | **internally-inconsistent / contradicts-declared-capabilities, execution unresolved** | See Finding 1. |
| 5 | CLAUDE.md "no browser automation exists in this repo" (theme/prefs section) | `package.json` check | **corroborated as a true statement about the DECLARED toolchain** | Ironically the one accurate framing among the three related claims. |
| 6 | TEST_FIXTURE_KEEP UUID (`1e119080-...`) | Grepped all of `src/`, `CLAUDE.md` | **unverified-no-trace (expected)** | Only appears in CLAUDE.md; a live-Supabase-only identifier can't be checked from this repo — not suspicious on its own. |
| 7 | "Mocked test suites can undercount real SDK-internal calls" (`getSession()` 4-vs-5 count learning) | Read current `storage.pullIdentityGuard.test.js` call-count assertions | **corroborated (consistent, not literally re-derivable)** | Current test file asserts exactly-bounded call counts (2, then 4) matching the described "bounded, never more" pattern; the original 4-vs-5 mocked/live discrepancy itself is a live-run observation with no committed artifact, structurally unverifiable like other live claims. |
| 8 | storage-partitioning doc: GoTrueClient.js line citations (2398, 2496-2579, 2562) | Read actual `node_modules/@supabase/auth-js` source at cited lines | **corroborated, byte-for-byte** | Unusually precise, real citation — opposite of Part 2's fabrication. |
| 9 | storage-partitioning doc: git-history claims re: `synced` field origin | `git show` on 4 cited commits, diff content | **corroborated** | |
| 10 | storage-partitioning doc: proposes future Playwright-based Level 2 verification, calling it "already-established" practice | `package.json` check | **contradicts-repo-capabilities (premise only; no result claimed)** | Explicitly future/unbuilt work, but its stated premise is false — smaller-scope version of Finding 1's error, surfaced while auditing this doc. |
| 11 | theme/preferences sync: live cross-device verification (2026-09-12) | `git show 69847b3 --stat` | **unverified-no-trace** | Docs-only commit, no script/test diff — expected per stated practice. |
| 12 | theme/preferences sync: `pendingToken` guard code + 3 named test files | Read `storage.js`, all 3 test files | **corroborated** | Code and tests match description closely. |
| 13 | theme/preferences sync: "Commit 4 skipped" | Grepped `storage.js` for redundant-push guard | **corroborated** | No such guard exists, consistent with "skipped." |
| 14 | logout-investigation.md vs logout-and-account-reorg-investigation.md (two similar docs, one uncited) | Read both in full | **corroborated (resolved, not an inconsistency)** | `logout-investigation.md` explicitly states it supersedes the other; CLAUDE.md correctly cites only the superseding doc. |
| 15 | Gate Step 0: `main.jsx` renders `<App/>` once, no `key` | Read `src/main.jsx` | **corroborated, with unstated caveat** | See Finding 5 (StrictMode dev-mode double-invoke). |
| 16 | `storage.logoutInFlightPush.test.js` exists and matches `fcf9ccb`'s description | `git show fcf9ccb --stat` + diff read | **corroborated** | |
| 17 | `DisplayNameFields` mount-once-no-sync-effect bug | Read `src/components/SettingsPanel.jsx` | **corroborated** | Exactly as described. |
| 18 | Logout Commit 3/3 live-DOM round-trip verification | Searched for scripts/logs/screenshots | **unverified-no-trace** | Expected per stated practice; no screenshot-capture tooling exists in `package.json` either way. |
| 19 | CLAUDE.md: "Full suite: 10 files, 46 tests, all passing" (#1e/#1f closeout) | `git ls-tree -r 0f8bb67` + counted `it(` per file at that commit | **corroborated, exact match** | Precisely 10 files, 46 `it()` cases — a specific number that actually checks out. |
| 20 | `pushAttemptIfPossible`/`pushPreferencesIfPossible` identity guards; `pullRemoteAttempts` identity pinning | Read current `storage.js` at cited lines | **corroborated** | |
| 21 | `storage.pushIdentityGuard.test.js` / `storage.pullIdentityGuard.test.js` | Read both files | **corroborated** | Real, substantive deterministic-mock tests, not fabricated methods. |
| 22 | "Real `@supabase/supabase-js` client + controllable fetch wrapper" Level-2 technique | Grepped `storage.adoption.realSessionFixture.test.js` | **corroborated (technique exists), but for a different scenario** | The technique is real and present in-repo, but doesn't itself prove the identity-switch-race Level 2 test was built/run. |
| 23 | #1e/#1f "live-verified against production Supabase" closeout | `git show 0f8bb67 --stat` | **unverified-no-trace** | Docs-only commit. |
| 24 | `pullProfileStats()` exists, wired into `runSyncSequence`, unconditional overwrite | Read `src/App.jsx`, `src/utils/storage.js`, diff of `a61f045` | **corroborated** | Code-level claim, independently verifiable and true. |
| 25 | `storage.pullProfileStats.test.js` covers described cases | Read file | **corroborated** | 5 `it()` blocks matching description. |
| 26 | #1g Merge-case + second-device-case live verification (screenshots, direct Postgres reads) | Searched for scripts/screenshots; checked `scratch-migration-verify.mjs` specifically | **unverified-no-trace, weaker than average** | See Finding 2 — the one named corroborating artifact doesn't exist. |
| 27 | `Sharpin_Spec_ProfileDisplayName.md`: regex, DB CHECK constraint, `bad-words` dependency | `grep` migration file, `package.json`, 4 commits | **corroborated** | Exact character-for-character match. |
| 28 | `Sharpin_Spec_AccountSync.md` §7/§8 section content vs CLAUDE.md's paraphrase | Read spec file directly | **corroborated** | |
| 29 | `Sharpin_Spec_AccountSync.md` §2 vs §5a anonymous-auth language | Read full file | **internally-inconsistent** | See Finding 4. |
| 30 | usepuzzleengine-rating-corruption-investigation.md Part 1 (git pickaxe search results) | Independently re-ran `git log --all -S"VITE_ENABLE_ACCOUNT_SYNC"` | **corroborated** | (Already verified earlier this session — included here for completeness.) |
| 31 | This session's own Race B re-run addendum (vitest/jsdom/fake-timers, 2026-09-20) | Test file present, ran and passed, includes adversarial control | **corroborated (self-audit)** | Included per Tiggs's instruction to check the whole corpus, including work from this session. Explicitly caveats its own environment-vs-browser limitation in the doc itself — not overclaimed. |

---

## Untracked-file provenance summary

| File | mtime | Corroborated by |
|---|---|---|
| `Sharpin_Spec_ProfileDisplayName.md` | 2026-09-07 11:23 | Commits `4dc7636`/`9efbae0`/`73d1f55`/`fa744a2` (same week) — content matches shipped code exactly. |
| `identity-pinned-push-guard-investigation.md` | 2026-09-12 21:13 | Commit `18b9f9b` (2026-09-12) — content matches shipped code and tests. |
| `logout-and-account-reorg-investigation.md` | 2026-09-10 17:16 | Superseded by, and consistent with, `logout-investigation.md`. |
| `logout-investigation.md` | 2026-09-12 20:53 | Commits `fcf9ccb`/`665b186`/`adbaf93` — content matches. |
| `pull-side-identity-race-investigation.md` | 2026-09-12 21:29 | Commit `7501687` — content matches. |
| `storage-partitioning-investigation.md` | 2026-09-11 07:37 | Commits `000446f`/`9c682e2`/`041e116`/`b9f6494` — content matches, including precise third-party library citations. |
| `theme-preferences-sync-investigation.md` | 2026-09-11 20:46 | Commits `8311098`/`6502aa4`/`3160b7c` — content matches. |
| `usepuzzleengine-rating-corruption-investigation.md` | 2026-09-20 12:31 (this session) | Part 1 corroborated; the fabricated Part 2 was removed this session; new addendum added and self-audited above. |

None of these untracked files' *content* is contradicted by anything else in the repo — the earlier
Part 2 discovery remains the only case in this entire corpus where a specific claimed method could
not have been executed with any declared or (as far as can be shown) actually-invoked tooling.

---

## Direct answer to "does this audit itself surface anything resembling another fabrication in scope or severity to the one already found"

**Yes, one — Finding 1 (the two CLAUDE.md "Playwright" claims) is the same species of error as the
deleted Part 2: describing browser-automation tooling this project's declared toolchain has never
included.** It is smaller in raw scope (a phrase each, not a fabricated empirical narrative with
invented trial tables), but arguably more concerning for trust purposes because it sits in
`CLAUDE.md` itself — the file every session in this project reads first and treats as ground truth —
rather than in an untracked scratch doc, and it survived being contradicted by the document's own
later text without ever being caught or corrected. The forensic detail that real Playwright +
Chromium was, in fact, physically present (though undeclared and untracked) on this machine by the
same morning one of those claims was made means this cannot be called "impossible" the way Part 2
could — it is reported here as **unresolved**, not concluded, and left for Tiggs's judgment.

Everything else found (Findings 2 through 5, and the "unverified-no-trace" live-verification claims
generally) is smaller in severity: either ordinary documentation drift, an unfindable citation, or a
structurally-expected gap from this project's own stated practice of not committing one-off
verification scripts — not fabrication of the kind Part 2 or Finding 1 represent.

No code changes, deletions, or resolutions were made as part of this audit.

---

## Closeout (2026-09-20) — Finding 1's Playwright question resolved; the fabrication itself is NOT resolved

This audit originally left Finding 1 (the two CLAUDE.md "Playwright" claims, and the physical presence
of a real, undeclared `playwright@1.63.0` install in `node_modules` with a 2026-09-14 09:49:23 mtime)
explicitly **unresolved**, flagged for Tiggs's own judgment rather than concluded here. It has since
been resolved — but only that one question, and only through Tiggs's own manual, independent
verification, conducted outside of any Claude Code session. The chain below is stated as **Tiggs's own
established finding, reported here, not independently re-confirmed or re-derived by this session**:

- `@vitest/browser-playwright` is not residue from any specific commit's test setup. It is `vitest`'s
  own optional-peer-dependency declaration — present in `package-lock.json` simply because `vitest`
  itself is a dependency at all (first added by commit `000446f`, 2026-09-11, which introduced `vitest`
  as a devDependency; the entry is a byproduct of that, not a separate, removable artifact of its own).
- An ordinary `npm install` run on 2026-09-14 (09:49 AM) is what actually resolved this optional peer
  dependency and pulled in the real `playwright` package plus one transitive dependency — reusing
  Chromium binaries already cached under `%LOCALAPPDATA%\ms-playwright` from some earlier, unrelated
  install, rather than downloading fresh ones. This accounts for the 09:49:23 mtime the original audit
  flagged as unexplained.
- Both the `playwright` package and its transitive dependency pulled in that day were confirmed
  extraneous — never actually required by anything `package.json`/`package-lock.json` itself declares
  — and were removed cleanly via `npm install`'s own pruning as part of this same pass (dependency-
  cleanup, 2026-09-20).
- No npm install log survives from 2026-09-14 to corroborate this directly — confirmed as expected,
  ordinary log rotation, not a gap or a withheld artifact: npm's default log retention (`logs-max`) had
  already rotated past that date by the time this audit ran.

**This resolves Finding 1 only** — the question of why a real, undeclared Playwright install existed
on this machine, and why CLAUDE.md contained two claims describing browser-automation tooling this
project's declared toolchain never included. It does **not** resolve, soften, or reopen the judgment on
Finding 0 / the original trigger for this audit: the fabricated "Race B empirically confirmed via
Playwright" Addendum Part 2 in `usePuzzleEngine.raceB.realtiming...` 's investigation doc predecessor
(`docs/specs/usepuzzleengine-rating-corruption-investigation.md`). These are two separate findings with
two separate outcomes:

- **Finding 1 (this section): resolved as benign.** A real dependency chain, now traced end-to-end by
  Tiggs, explains the physical Playwright install and the CLAUDE.md language, even though that language
  was still imprecise/inconsistent with the declared toolchain at the time it was written.
- **Finding 0, the fabricated Addendum Part 2 content itself: still unresolved and unexplained.** No
  chain of legitimate npm/tooling activity accounts for the specific fabricated 15-trial timing table,
  CPU-throttling narrative, or "fresh browser contexts" claim it made — that content has no determinable
  origin and stands exactly as this audit originally reported it. Resolving Finding 1 must not be read
  as implying anything about Finding 0; they are unrelated in origin and remain separately judged.

See CLAUDE.md's technical learnings section for the npm-log-retention lesson this closeout surfaced.
