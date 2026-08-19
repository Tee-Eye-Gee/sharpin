-- Sharpin: Account Auth & Cross-Device Sync (backlog #1), Stage 2 revision
-- Rate-limit ledger for verify-move-sequence, the one intentionally
-- pre-auth, publicly-callable Edge Function in this system. See report for
-- full reasoning.
--
-- NOT APPLIED to any live project. Written for review only.
--
-- No RLS policies (RLS is still enabled, per the project's standard): this
-- table is written and read exclusively by verify-move-sequence's
-- service-role client, the same way profiles' pre-auth hash lookup works
-- (see 20260819140001_rls_policies.sql's design note). No client ever has,
-- or should have, a direct authenticated-role path to this table -- it's
-- rate-limit bookkeeping, not user data, and has nothing to scope to
-- auth.uid() in the first place (the caller isn't authenticated as anyone
-- yet when this table gets written). RLS enabled + zero policies = fully
-- denied to every non-service-role caller, which is exactly the intent.
create table if not exists public.verify_attempts (
  id           uuid primary key default gen_random_uuid(),
  ip_address   text not null,
  attempted_at timestamptz not null default now()
);

-- Supports the sliding-window "count attempts for this IP in the last N
-- minutes" query the Edge Function runs on every call.
create index if not exists verify_attempts_ip_attempted_idx
  on public.verify_attempts (ip_address, attempted_at);

alter table public.verify_attempts enable row level security;

-- Deliberately no updated_at/created_at-style trigger enforcement here,
-- unlike the tables in 20260819140000_init_schema.sql: those triggers
-- exist because those tables are writable by authenticated clients who
-- could otherwise supply their own timestamp. This table is never
-- client-writable at all (no policies, service-role only), so there's no
-- untrusted path that could lie about attempted_at -- the plain column
-- default is sufficient.
--
-- No pruning/cleanup of old rows in this migration -- flagged as a known
-- future nice-to-have (e.g. a periodic job deleting rows older than the
-- rate-limit window), not built now per the Stage 2 revision instructions.
