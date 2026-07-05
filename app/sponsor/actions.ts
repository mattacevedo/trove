"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Create a new sponsor organization for the current user via the create_sponsor RPC
 * (SECURITY DEFINER: inserts sponsors + sponsor_admins atomically), then open the dashboard.
 */
export async function createSponsor(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/sponsor/new?error=name_required");

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("create_sponsor", { sponsor_name: name });
  if (error) redirect("/sponsor/new?error=create_failed");

  redirect("/sponsor");
}
