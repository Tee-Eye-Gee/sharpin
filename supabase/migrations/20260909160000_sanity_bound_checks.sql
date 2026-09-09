-- Sharpin: Ongoing Sync (backlog #1 continuation), Commit 5
-- Sanity-bound checks on profile_stats/theme_stats -- a second, independent
-- layer against a bad value ever landing there, on top of recompute_stats()
-- being the only intended write path (Commit 3). Two tiers, matching the
-- locked design:
--   1. CHECK constraints: cheap, single-row invariants, hard-reject.
--   2. BEFORE INSERT OR UPDATE triggers: cross-table reconciliation against
--      puzzle_attempts (the ground truth), log-only via anomaly_log --
--      NEVER raises, NEVER blocks the write, even on a real mismatch. This
--      is deliberate: catching a client that bypassed recompute_stats() and
--      upserted profile_stats/theme_stats directly (RLS only enforces row
--      ownership, not value correctness) is a detection concern, not a
--      correctness-enforcement one -- the locked decision is "log it, let
--      it through."

-- ============================================================================
-- profile_stats CHECK constraints
-- ============================================================================
alter table public.profile_stats
  add constraint profile_stats_rating_check check (rating >= 0),
  add constraint profile_stats_total_solved_check check (total_solved >= 0),
  add constraint profile_stats_total_failed_check check (total_failed >= 0),
  add constraint profile_stats_streak_check check (best_streak >= current_streak);

-- ============================================================================
-- anomaly_log
-- Append-only. Self-scoped RLS matching every other table's shape
-- (20260819140001_rls_policies.sql) -- the trigger functions below run
-- SECURITY INVOKER (the default, no specifier), so their own inserts into
-- this table are subject to this same policy under the calling session's
-- auth.uid(), same as the outer profile_stats/theme_stats write they're
-- reacting to.
-- ============================================================================
create table if not exists public.anomaly_log (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  table_name       text not null,
  attempted_value  jsonb not null,
  expected_value   jsonb not null,
  logged_at        timestamptz not null default now()
);

create index if not exists anomaly_log_profile_id_idx on public.anomaly_log (profile_id);

alter table public.anomaly_log enable row level security;

create policy "anomaly_log_owner_only"
  on public.anomaly_log
  for all
  to authenticated
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

-- No explicit grant needed: 20260822203000_grant_table_privileges.sql's
-- `alter default privileges in schema public grant ... on tables to anon,
-- authenticated, service_role` already covers any table created after it,
-- anomaly_log included.

-- ============================================================================
-- profile_stats reconciliation trigger
-- rating and total_solved/total_failed are reconciled EXACTLY against
-- puzzle_attempts (same formulas as recompute_stats()). best_streak gets
-- only a LOOSE bound (best_streak <= the just-computed true total_solved --
-- a user can never have a best-ever streak longer than their lifetime solve
-- count) -- exact streak reconciliation via window function is explicitly
-- deferred, not built here. current_streak <= best_streak is already a hard
-- CHECK constraint above, not re-checked here.
-- ============================================================================
create or replace function public.check_profile_stats_anomaly()
returns trigger
language plpgsql
as $$
declare
  v_expected_rating integer;
  v_expected_total_solved integer;
  v_expected_total_failed integer;
  v_mismatch boolean := false;
begin
  select
    1200 + coalesce(sum(rating_delta), 0), -- 1200 must stay in sync with src/utils/rating.js's DEFAULT_RATING
    count(*) filter (where solved),
    count(*) filter (where not solved)
  into v_expected_rating, v_expected_total_solved, v_expected_total_failed
  from public.puzzle_attempts
  where profile_id = new.profile_id;

  if new.rating is distinct from v_expected_rating
     or new.total_solved is distinct from v_expected_total_solved
     or new.total_failed is distinct from v_expected_total_failed
     or new.best_streak > v_expected_total_solved
  then
    v_mismatch := true;
  end if;

  if v_mismatch then
    insert into public.anomaly_log (profile_id, table_name, attempted_value, expected_value)
    values (
      new.profile_id,
      'profile_stats',
      jsonb_build_object(
        'rating', new.rating,
        'total_solved', new.total_solved,
        'total_failed', new.total_failed,
        'best_streak', new.best_streak,
        'current_streak', new.current_streak
      ),
      jsonb_build_object(
        'rating', v_expected_rating,
        'total_solved', v_expected_total_solved,
        'total_failed', v_expected_total_failed,
        'best_streak_bound', v_expected_total_solved
      )
    );
  end if;

  return new;
end;
$$;

create trigger profile_stats_check_anomaly
  before insert or update on public.profile_stats
  for each row execute function public.check_profile_stats_anomaly();

-- ============================================================================
-- theme_stats reconciliation trigger
-- attempts/solved are reconciled EXACTLY against puzzle_attempts, using
-- array-containment (themes && ARRAY[theme]) rather than an equality/unnest
-- join -- confirmed via EXPLAIN (ANALYZE, BUFFERS) against live data (with
-- enable_seqscan temporarily forced off to see the plan Postgres will use
-- once this table is large enough to prefer it over a seq scan) that this
-- query uses an Index Scan on puzzle_attempts_profile_id_idx (Index Cond:
-- profile_id = ...), applying the array-containment check as a cheap Filter
-- on the already-narrowed, per-profile row set -- not assumed efficient, a
-- GIN index on themes is not needed since a single profile's own attempt
-- count stays bounded regardless of total table size.
-- ============================================================================
create or replace function public.check_theme_stats_anomaly()
returns trigger
language plpgsql
as $$
declare
  v_expected_attempts integer;
  v_expected_solved integer;
begin
  select
    count(*),
    count(*) filter (where solved)
  into v_expected_attempts, v_expected_solved
  from public.puzzle_attempts
  where profile_id = new.profile_id
    and themes && array[new.theme];

  if new.attempts is distinct from v_expected_attempts
     or new.solved is distinct from v_expected_solved
  then
    insert into public.anomaly_log (profile_id, table_name, attempted_value, expected_value)
    values (
      new.profile_id,
      'theme_stats',
      jsonb_build_object('theme', new.theme, 'attempts', new.attempts, 'solved', new.solved),
      jsonb_build_object('theme', new.theme, 'attempts', v_expected_attempts, 'solved', v_expected_solved)
    );
  end if;

  return new;
end;
$$;

create trigger theme_stats_check_anomaly
  before insert or update on public.theme_stats
  for each row execute function public.check_theme_stats_anomaly();
