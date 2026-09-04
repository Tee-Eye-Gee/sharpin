import { createClient } from '@supabase/supabase-js'

// Single shared client instance for the whole app. Session storage is left
// at supabase-js's default (localStorage) -- no custom storage adapter
// (locked decision, Sub-build B1: don't build one).
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
