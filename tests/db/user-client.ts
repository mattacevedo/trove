import { createClient } from "@supabase/supabase-js";
import { adminClient } from "./admin-client";

// Creates a confirmed auth user and returns an RLS-scoped client acting as them.
export async function makeUserClient(email: string) {
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;

  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { error: signInErr } = await client.auth.signInWithPassword({
    email,
    password: "test-password-123",
  });
  if (signInErr) throw signInErr;

  return { client, userId };
}
