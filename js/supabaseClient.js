// Single shared client — every page imports this instead of creating its own, so there's
// one session/auth state for the whole app (mirrors having one google.script.run-backed
// session in the old Apps Script app).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
