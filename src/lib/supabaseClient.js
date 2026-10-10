import { createClient } from '@supabase/supabase-js'

// Single shared client instance for the whole app. Session storage is left
// at supabase-js's default (localStorage) -- no custom storage adapter
// (locked decision, Sub-build B1: don't build one).
//
// detectSessionInUrl is off (Auth V2 step 2, decision Q8): auth emails link
// to the site root with ?token_hash=&type=, which src/lib/authUrl.js
// verifies explicitly. Nothing in Auth V2 uses a session in the URL, so the
// SDK's own detection (access_token / error params) has nothing to do.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { detectSessionInUrl: false } },
)
