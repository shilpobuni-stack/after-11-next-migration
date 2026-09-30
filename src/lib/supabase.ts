import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://invalid.supabase.co',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'missing-publishable-key'
);

export default supabase;
