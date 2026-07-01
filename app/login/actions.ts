"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

export async function sendOtp(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/auth/confirm`,
    },
  });
  if (error) redirect("/login?error=1");
  redirect("/login?sent=1");
}
