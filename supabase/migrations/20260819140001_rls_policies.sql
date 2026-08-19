-- Sharpin: Account Auth & Cross-Device Sync (backlog #1), Stage 2
-- RLS policies for the tables created in 20260819140000_init_schema.sql.
-- Split into its own migration for a clean "what does the schema look
-- like" vs "who can touch it" diff -- see report for reasoning.
--
-- NOT APPLIED to any live project. Written for review only.
--
-- Design note (spec §3 / Task B): the ONLY server-side path that needs to
-- read a profiles row before its owner is authenticated as that profile is
-- the verify-move-sequence Edge Function's move_sequence_hash lookup. That
-- function uses the service-role client, which bypasses RLS entirely by
-- Postgres/Supabase design (service_role carries BYPASSRLS). So that lookup
-- never touches these policies at all -- no anon-role SELECT policy is
-- needed on profiles (or any table) to support it, and adding one would
-- only be a liability (any anon caller could then read every hash). RLS
-- below is scoped to `authenticated` only, everywhere.

-- ============================================================================
-- profiles
-- Self-scoped by id (= auth.uid()). No anon policy anywhere in this file.
-- ============================================================================
create policy "profiles_owner_only"
  on public.profiles
  for all
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ============================================================================
-- puzzle_attempts / theme_stats / profile_stats / preferences
-- Self-scoped by profile_id = auth.uid(), identical shape on all four.
-- ============================================================================
create policy "puzzle_attempts_owner_only"
  on public.puzzle_attempts
  for all
  to authenticated
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

create policy "theme_stats_owner_only"
  on public.theme_stats
  for all
  to authenticated
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

create policy "profile_stats_owner_only"
  on public.profile_stats
  for all
  to authenticated
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

create policy "preferences_owner_only"
  on public.preferences
  for all
  to authenticated
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);
