import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { provisionEarner } from "@/lib/auth/provision-earner";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createServerClient();

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user?.email) {
        try {
          await provisionEarner(supabase, user.id, user.email);
        } catch {
          return NextResponse.redirect(new URL("/login?error=1", request.url));
        }
      }
      return NextResponse.redirect(new URL("/app", request.url));
    }
  }
  return NextResponse.redirect(new URL("/login?error=1", request.url));
}
