-- Sharpin: Account Auth & Cross-Device Sync (backlog #1), Stage 2
-- Initial schema per docs/specs/Sharpin_Spec_AccountSync.md §4.
--
-- NOT APPLIED to any live project. Written for review only.

-- ============================================================================
-- profiles
-- One row per Supabase Auth identity. id is intentionally the same value as
-- auth.users.id (= auth.uid() once signed in) rather than a separate
-- surrogate key, matching the spec's "id (uuid, = auth.uid())".
--
-- move_sequence_hash is UNIQUE: without this, two accounts could end up
-- with the same hash, and verify-move-sequence's .maybeSingle() lookup
-- would start erroring for both the moment that happened (fails closed,
-- but a real lockout bug) -- caught in review before this was ever applied.
-- ============================================================================
create table if not exists public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  move_sequence_hash text not null unique,
  created_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- ============================================================================
-- puzzle_attempts
-- Per-record LWW sync target (spec §4). attempted_at is the client-meaningful
-- "when did the user actually attempt this" timestamp (sourced from local
-- IndexedDB's `at`); updated_at is the server-set LWW conflict-resolution
-- timestamp only and must never be read as attempt time.
-- ============================================================================
create table if not exists public.puzzle_attempts (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  puzzle_id      text not null,
  themes         text[] not null default '{}',
  solved         boolean not null,
  hint_used      boolean not null default false,
  rating_delta   integer not null,
  time_taken_ms  integer not null,
  attempted_at   timestamptz not null,
  updated_at     timestamptz not null default now()
);

create index if not exists puzzle_attempts_profile_id_idx
  on public.puzzle_attempts (profile_id);

alter table public.puzzle_attempts enable row level security;

-- ============================================================================
-- theme_stats
-- Per-theme accuracy rollup (attempts/solved), mirrors local IndexedDB
-- `themeStats` store. Composite PK (profile_id, theme) mirrors that store's
-- per-theme keying, scoped per-profile.
-- ============================================================================
create table if not exists public.theme_stats (
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  theme       text not null,
  attempts    integer not null default 0,
  solved      integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (profile_id, theme)
);

alter table public.theme_stats enable row level security;

-- ============================================================================
-- profile_stats
-- Rolling rating/streak/count aggregate, one row per profile. Mirrors local
-- IndexedDB `profile` store, including totalSolved/totalFailed/bestStreak
-- (added per the Aug 18 investigation -- coach.js's overall-rate calc needs
-- totalSolved/totalFailed; ProgressPanel needs bestStreak).
-- ============================================================================
create table if not exists public.profile_stats (
  profile_id      uuid primary key references public.profiles (id) on delete cascade,
  rating          integer not null,
  current_streak  integer not null default 0,
  best_streak     integer not null default 0,
  total_solved    integer not null default 0,
  total_failed    integer not null default 0,
  updated_at      timestamptz not null default now()
);

alter table public.profile_stats enable row level security;

-- ============================================================================
-- preferences
-- Cross-device sync of appMode/boardTheme/inputMode (per Tiggs's explicit
-- decision to add this, per spec §4 -- not in the original draft).
-- ============================================================================
create table if not exists public.preferences (
  profile_id   uuid primary key references public.profiles (id) on delete cascade,
  app_mode     text,
  board_theme  text,
  input_mode   text,
  updated_at   timestamptz not null default now()
);

alter table public.preferences enable row level security;

-- ============================================================================
-- updated_at / created_at enforcement
-- Column defaults only cover the case where a client OMITS the column on
-- INSERT -- they do not stop a client from explicitly supplying their own
-- value. These triggers force the server-set value unconditionally, on
-- every write, so it is impossible for a client to supply updated_at (or
-- profiles.created_at) themselves, per spec §4's "server-set, now() -- this
-- is the LWW sync-conflict timestamp ONLY".
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.set_created_at()
returns trigger
language plpgsql
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

create trigger profiles_set_created_at
  before insert on public.profiles
  for each row execute function public.set_created_at();

create trigger puzzle_attempts_set_updated_at
  before insert or update on public.puzzle_attempts
  for each row execute function public.set_updated_at();

create trigger theme_stats_set_updated_at
  before insert or update on public.theme_stats
  for each row execute function public.set_updated_at();

create trigger profile_stats_set_updated_at
  before insert or update on public.profile_stats
  for each row execute function public.set_updated_at();

create trigger preferences_set_updated_at
  before insert or update on public.preferences
  for each row execute function public.set_updated_at();
