import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Resolve the current user's id AND the sponsor org they administer, or redirect.
 *
 * - unauthenticated -> redirect('/login')
 * - authenticated but administers no sponsor -> redirect('/sponsor/new')
 * - administers one or more -> return the FIRST (ordered by created_at).
 *
 * Multi-org selection (a cookie-backed "active sponsor") is deferred for v1; a user who
 * administers multiple orgs always lands on their oldest membership. RLS
 * (sponsor_admins_self_select) scopes the read to the caller, so no explicit user_id filter
 * is required here.
 */
export async function requireSponsorAdmin(): Promise<{ userId: string; sponsorId: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase
    .from("sponsor_admins")
    .select("sponsor_id")
    .order("created_at", { ascending: true });

  if (error || !data || data.length === 0) redirect("/sponsor/new");

  return { userId: user.id, sponsorId: data![0].sponsor_id as string };
}
