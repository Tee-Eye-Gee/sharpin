-- Sharpin: Auth V2, build step 1 (schema / auth backend).
-- Spec: docs/specs/Sharpin_Spec_AuthV2.md §6.
--
-- Auth V2 makes email the identifier and the move sequence the password
-- (Supabase Auth's own signUp/signInWithPassword, bcrypt server-side), so
-- the V1 custom-auth schema retires here:
--   - profiles.move_sequence_hash and its UNIQUE constraint (D4: sequences
--     no longer need to be unique; email tells users apart).
--   - verify_attempts / create_account_attempts, the per-IP throttle
--     ledgers for the retired verify-move-sequence / create-account Edge
--     Functions (D9: Supabase Auth's built-in rate limits replace them).
-- Prerequisite: both V1 Edge Functions undeployed first, so neither can
-- hit a missing column or table mid-migration.
--
-- Profile rows are now created by a trigger on auth.users rather than by
-- an Edge Function. signUp returns no session until the email is
-- confirmed (D2), so the client has no authenticated moment at which RLS
-- (profiles_owner_only, `to authenticated`) would let it insert its own
-- row. The trigger inserts (id) only: display_name is set later through
-- update-profile, which is where the profanity check lives.
--
-- The column drop and the trigger ship together: with move_sequence_hash
-- still NOT NULL, every trigger insert (and so every signup) would fail.

-- Constraint name confirmed against production before writing this
-- (pg_constraint on public.profiles, 2026-10-09). Dropping the column would
-- remove it anyway; dropped explicitly so the intent is on the page.
alter table public.profiles drop constraint if exists profiles_move_sequence_hash_key;
alter table public.profiles drop column if exists move_sequence_hash;

drop table if exists public.verify_attempts;
drop table if exists public.create_account_attempts;

-- security definer: runs as its owner, so it can insert into
-- public.profiles regardless of RLS and of the role Supabase Auth uses to
-- write auth.users. search_path = '' with fully qualified names, per
-- Supabase's guidance for security definer functions. Kept to a single
-- idempotent insert: if this trigger errors, the auth.users insert (the
-- signup itself) fails with it.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
