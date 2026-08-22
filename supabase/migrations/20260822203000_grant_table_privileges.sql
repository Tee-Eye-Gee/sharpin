-- Sharpin: Account Auth & Cross-Device Sync (backlog #1), Stage 2 apply-to-live fix
--
-- Discovered during live verification (2026-08-22, second freshly created
-- project): none of the prior three migrations grant table-level privileges
-- to anon/authenticated/service_role, relying instead on Supabase's usual
-- project-bootstrap default of auto-granting SELECT/INSERT/UPDATE/DELETE on
-- public-schema tables to those three roles. On this project that default
-- did not take effect -- confirmed via information_schema.role_table_grants
-- showing only REFERENCES/TRIGGER/TRUNCATE for anon/authenticated/service_role
-- on all 6 tables, and via a direct PostgREST call with the service-role key
-- returning 42501 "permission denied for table verify_attempts" (schema
-- USAGE was present; only table grants were missing). RLS enforcement is
-- unaffected either way -- these are the outer table-privilege gate, not
-- the row-level policies from 20260819140001_rls_policies.sql.
--
-- anon gets baseline CRUD grants here too even though no RLS policy in this
-- schema currently grants it any rows: matches Supabase's normal default
-- posture, and RLS (enabled with no anon policy anywhere) still reduces
-- anon's actual visible/writable rows to zero. Granting now avoids the same
-- surprise resurfacing silently if an anon-accessible table is ever added
-- later without someone remembering this gap exists.

grant select, insert, update, delete
  on public.profiles,
     public.puzzle_attempts,
     public.theme_stats,
     public.profile_stats,
     public.preferences,
     public.verify_attempts
  to anon, authenticated, service_role;

-- So any table created by a future migration (e.g. backlog #2's analytics
-- work) inherits these grants automatically instead of silently repeating
-- this gap -- this is the behavior Supabase's project bootstrap is supposed
-- to set up by default and apparently didn't on this project.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
