"use server";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";

/**
 * Flip the signed-in earner's public_profile_enabled. RLS (earners_self_update, 0003) guarantees
 * an earner can only ever update their OWN row — even if requireUserId() were bypassed, the update
 * would fail closed. requireUserId() is still called for a clean /login redirect (defense in depth).
 * No redirect on success: we stay on /app and let revalidatePath re-render from fresh server data.
 */
export async function updatePublicProfileEnabled(formData: FormData): Promise<void> {
  const enabled = formData.get("enabled") === "true";
  const userId = await requireUserId();
  const supabase = await createServerClient();
  await supabase.from("earners").update({ public_profile_enabled: enabled }).eq("id", userId);
  revalidatePath("/app");
}
