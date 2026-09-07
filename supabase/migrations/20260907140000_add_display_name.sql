-- Sharpin: Profile Display Name (backlog #2)
-- Adds the optional, human-readable identity signal per
-- docs/specs/Sharpin_Spec_ProfileDisplayName.md. Purely a display/UX
-- addition -- does not touch identity, auth, or the sequence-hash login
-- mechanism (spec overview).
--
-- Nullable by design (spec: "Optionality: Optional. Never required to
-- create an account or log in."). The CHECK constraint enforces only the
-- length (3-20) + character-set (ASCII letters/digits/space/hyphen/
-- underscore) rules from the spec's locked validation framework -- it
-- deliberately allows NULL through the `display_name is null or ...`
-- branch, since an empty/unset name is a valid, common state. Profanity
-- filtering is NOT DB-enforceable (spec: "Profanity is not DB-enforceable
-- and stays an app/Edge-Function responsibility") and is handled entirely
-- in application code (create-account and update-profile Edge Functions).
--
-- No grant statement needed here: 20260822203000_grant_table_privileges.sql's
-- grants are table-level (SELECT/INSERT/UPDATE/DELETE on all of
-- public.profiles for anon/authenticated/service_role), not column-level,
-- and this project doesn't use column-level privilege restrictions
-- anywhere -- a new column on an already-granted table is automatically
-- covered, confirmed by querying information_schema.role_table_grants
-- post-apply rather than assumed (see build report).

alter table public.profiles
  add column display_name text,
  add constraint profiles_display_name_check
    check (display_name is null or display_name ~ '^[A-Za-z0-9 _-]{3,20}$');
