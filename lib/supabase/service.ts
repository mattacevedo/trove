// lib/supabase/service.ts
// Service-role Supabase client for SERVER-ONLY, RLS-bypassing writes (e.g. the Stripe webhook, which
// updates `sponsors` for a customer that the request is not authenticated as). NEVER import this into
// a client component or any code that runs in the browser — it holds the service key. Mirrors the
// test-only tests/db/admin-client.ts, but lives in lib/ because production code (the webhook route)
// depends on it.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createServiceRoleClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
