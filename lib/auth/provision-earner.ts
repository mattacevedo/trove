import type { SupabaseClient } from "@supabase/supabase-js";

function handleFromEmail(email: string): string {
  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "user"}-${suffix}`;
}

export async function provisionEarner(
  db: SupabaseClient,
  userId: string,
  email: string
): Promise<{ handle: string }> {
  const { data: existing } = await db
    .from("earners")
    .select("handle")
    .eq("id", userId)
    .maybeSingle();

  if (existing) return { handle: existing.handle };

  // retry on rare handle collision
  for (let i = 0; i < 5; i++) {
    const handle = handleFromEmail(email);
    const { error } = await db
      .from("earners")
      .insert({ id: userId, handle, display_name: "" });
    if (!error) return { handle };
    if (error.code !== "23505") throw error; // not a unique violation
  }
  throw new Error("could not allocate a unique handle");
}
