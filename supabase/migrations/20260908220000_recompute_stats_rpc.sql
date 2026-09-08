-- Sharpin: Ongoing Sync (backlog #1 continuation), Commit 3
-- Adds recompute_stats(), the single source of truth for profile_stats/
-- theme_stats going forward. Locked decision: stats are never written by a
-- client-computed direct upsert after this point -- only this RPC may write
-- them (LaunchOverlay.jsx's migrateGuestDataToAccount is unified onto it in
-- Commit 6).
--
-- SECURITY INVOKER (the default -- stated explicitly here rather than left
-- implicit, matching the locked decision not to use SECURITY DEFINER): the
-- existing RLS policies on puzzle_attempts/profile_stats/theme_stats
-- already scope every caller to their own rows, which is exactly the row
-- set this function needs -- SECURITY DEFINER would reopen a trust gap
-- this design exists to close. No parameters: identity comes from
-- auth.uid() internally, not a profile_id argument, for the same reason.
--
-- starting_rating is DEFAULT_RATING (src/utils/rating.js) = 1200, confirmed
-- by reading that file directly rather than assumed. rating_delta values
-- already reflect each attempt's actual (post-clamp) rating change --
-- updateRating() returns delta as newRating - userRating, i.e. the real
-- displacement after Math.max(100, ...) clamping was applied at that step
-- -- so starting_rating + sum(rating_delta) telescopes to the exact final
-- rating without needing to re-simulate per-step clamping here.
--
-- Streaks are computed via the standard gaps-and-islands technique: rn is
-- each attempt's position in attempted_at order; among solved=true rows
-- only, rn - (row_number() over the same order, partitioned by solved)
-- is constant within one consecutive run and changes at every gap, so
-- grouping by it yields each run's length. best_streak is the longest such
-- run; current_streak is the run ending at the very last attempt (rn =
-- total attempt count), or 0 if that last attempt wasn't solved (no
-- matching group) or there are no attempts at all.
--
-- Idempotent and side-effect-free beyond the upserts by construction: both
-- computations are pure deterministic reads of puzzle_attempts, so calling
-- this twice with no new attempts in between produces byte-identical
-- upserted values both times.

create or replace function public.recompute_stats()
returns void
language plpgsql
security invoker
as $$
declare
  v_profile_id uuid := auth.uid();
  v_rating integer;
  v_total_solved integer;
  v_total_failed integer;
  v_current_streak integer;
  v_best_streak integer;
  v_total_attempts integer;
begin
  if v_profile_id is null then
    raise exception 'recompute_stats requires an authenticated caller';
  end if;

  select
    1200 + coalesce(sum(rating_delta), 0), -- 1200 must stay in sync with src/utils/rating.js's DEFAULT_RATING
    count(*) filter (where solved),
    count(*) filter (where not solved),
    count(*)
  into v_rating, v_total_solved, v_total_failed, v_total_attempts
  from public.puzzle_attempts
  where profile_id = v_profile_id;

  with ordered as (
    -- Tiebreak on id: two attempts sharing an identical attempted_at value
    -- (rare but possible -- e.g. two rapid solves whose client clock reads
    -- the same millisecond) would otherwise have Postgres-undefined
    -- relative order here, breaking this function's own idempotency
    -- guarantee for that specific case (a second call could re-order them
    -- and compute a different streak grouping).
    select solved, row_number() over (order by attempted_at, id) as rn
    from public.puzzle_attempts
    where profile_id = v_profile_id
  ),
  groups as (
    select solved, rn, rn - row_number() over (partition by solved order by rn) as grp
    from ordered
  ),
  run_lengths as (
    select grp, count(*) as run_len, max(rn) as last_rn
    from groups
    where solved
    group by grp
  )
  select
    coalesce((select max(run_len) from run_lengths), 0),
    coalesce((select run_len from run_lengths where last_rn = v_total_attempts), 0)
  into v_best_streak, v_current_streak;

  insert into public.profile_stats (profile_id, rating, current_streak, best_streak, total_solved, total_failed)
  values (v_profile_id, v_rating, v_current_streak, v_best_streak, v_total_solved, v_total_failed)
  on conflict (profile_id) do update set
    rating = excluded.rating,
    current_streak = excluded.current_streak,
    best_streak = excluded.best_streak,
    total_solved = excluded.total_solved,
    total_failed = excluded.total_failed;

  insert into public.theme_stats (profile_id, theme, attempts, solved)
  select v_profile_id, theme, count(*), count(*) filter (where solved)
  from public.puzzle_attempts, unnest(themes) as theme
  where profile_id = v_profile_id
  group by theme
  on conflict (profile_id, theme) do update set
    attempts = excluded.attempts,
    solved = excluded.solved;
end;
$$;

-- This project's default-privilege bootstrap did not auto-grant as expected
-- for tables (see 20260822203000's comment) -- explicit EXECUTE grant here
-- rather than assuming PostgREST's normal default applies on this project.
-- authenticated only: the function itself already rejects a null auth.uid()
-- (anon has no session to derive one from), so there's nothing for anon to
-- usefully call here.
grant execute on function public.recompute_stats() to authenticated;
