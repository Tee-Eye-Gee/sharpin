# Sharpin — Spec: Profile Display Name

**Status:** Scope locked, ready for investigation prompt
**Backlog position:** #2 (behind sequence board theme inheritance)

## Overview

Adds a human-readable identity signal so a user has independent confirmation of which account they're logged into, beyond the 4-move sequence itself. Purely a display/UX addition — does not touch identity, auth, or the sequence-hash login mechanism in any way.

## Scope decisions locked

- **Optionality:** Optional. Never required to create an account or log in.
- **Where set/edited:** Both — an optional field on the Create Account screen, and editable anytime afterward from Settings.
- **Function:** Display-only / self-facing identity signal. Not used for search, lookup, friend-finding, or any uniqueness enforcement. No collision handling needed.
- **Visibility:** Always visible to the account holder. Also intended to be readable from a future admin/analytics view (not built yet) — so the column and validation should not need rework when that view is eventually built.
- **Schema change:** Approved. Add a nullable `display_name` column to the `profiles` table.

## Validation framework (locked)

- **Length:** 3–20 characters.
- **Character set:** ASCII letters, digits, spaces, hyphens, underscores only.
  Regex: `^[A-Za-z0-9 _-]{3,20}$`
- **Profanity filter:** Static offline wordlist package (e.g. `leo-profanity` or `bad-words` — final pick during investigation based on maintenance status and zero external network calls), enforced in two places:
  1. Client-side at input time, for immediate "try again" feedback.
  2. Server-side in the relevant Edge Function write path — this is the actual enforcement point, since client-side checks are trivially bypassable.
- **DB-level defense:** `CHECK` constraint on `display_name` enforcing the length + character regex. (Profanity is not DB-enforceable and stays an app/Edge-Function responsibility.)

## Explicitly out of scope

- Search or lookup by display name.
- Any social, leaderboard, or comparative feature use.
- Uniqueness enforcement.
- A moderation queue or admin review workflow — filtering is automatic/static-list only.

## Open items for the investigation pass (not yet decided — investigate, don't build)

- Whether Settings currently has any existing "edit profile" UI/section to extend, or whether new UI is needed.
- Exact insertion point(s): does `create-account` Edge Function need a new optional parameter, and does a *separate* update path need to be created (or extended) for the Settings edit case?
- Confirm which of `leo-profanity` / `bad-words` (or an equivalent) has no external API calls and is actively maintained, for the actual dependency choice.
- Whether the existing profile fetch/read path needs any change to surface `display_name` to the UI, or if it can piggyback on data already being fetched.
