import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseServiceClient(
  supabaseUrl: string | undefined,
  supabaseServiceRoleKey: string | undefined
): SupabaseClient | null {
  if (!supabaseUrl || !supabaseServiceRoleKey) return null;

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
