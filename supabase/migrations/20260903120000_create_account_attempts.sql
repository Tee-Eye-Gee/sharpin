-- Sharpin: Account Auth & Cross-Device Sync (backlog #1), Stage 3
-- Rate-limit ledger for the create-account Edge Function (spec §5a).
--
-- Deliberately a separate table from verify_attempts, not a shared table
-- with an operation-type column. Reasoning (see build report): reusing
-- verify_attempts would require adding an operation-type column and then
-- changing verify-move-sequence's already-live rate-limit query to filter
-- by it -- touching a code path this project has twice lost a Supabase
-- project over getting wrong, for a change that belongs to an unrelated
-- feature with its own throttle tuning (3/60min vs. 10/15min: create-account
-- is a one-time-per-legitimate-user operation, verify-move-sequence is the
-- repeated login-retry hot path). A separate table has zero blast radius on
-- verify-move-sequence's existing query.
--
-- Same posture as verify_attempts (20260819140002_verify_attempts.sql): RLS
-- enabled, zero policies -- this table is written and read exclusively by
-- create-account's service-role client. No client has, or should have, a
-- direct authenticated-role path to it; the caller isn't authenticated as
-- anyone yet when this table gets written.
create table if not exists public.create_account_attempts (
  id           uuid primary key default gen_random_uuid(),
  ip_address   text not null,
  attempted_at timestamptz not null default now()
);

-- Supports the sliding-window "count attempts for this IP in the last N
-- minutes" query the Edge Function runs on every call.
create index if not exists create_account_attempts_ip_attempted_idx
  on public.create_account_attempts (ip_address, attempted_at);

alter table public.create_account_attempts enable row level security;

-- No explicit grant statement here: 20260822203000_grant_table_privileges.sql
-- already set `alter default privileges in schema public grant select,
-- insert, update, delete on tables to anon, authenticated, service_role`
-- specifically so future tables (this one) wouldn't need to repeat that
-- migration's fix. Verified live during this migration's own apply pass
-- (see build report) rather than assumed, given that migration exists
-- precisely because a prior assumption like that was wrong once already on
-- this project.
--
-- No pruning/cleanup of old rows in this migration, matching
-- verify_attempts' same deferred-nice-to-have note.
