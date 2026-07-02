import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Resolve the current authenticated earner's id, or redirect to /login.
 * Extracted from app/app/wallet/actions.ts so multiple Server Action files share one copy.
 */
export async function requireUserId(): Promise<string> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user.id;
}
