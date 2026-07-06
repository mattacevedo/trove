import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { provisionEarner } from "@/lib/auth/provision-earner";

/**
 * Completes email sign-in. Handles BOTH link formats:
 *
 * 1. `?token_hash=...&type=...` — the @supabase/ssr-recommended format, produced by
 *    custom email templates and by admin-generated links. Verified via verifyOtp.
 * 2. `?code=...` — produced by Supabase's DEFAULT email templates (free tier cannot
 *    customize templates without custom SMTP, so production currently sends these):
 *    the emailed link hits Supabase's own /verify endpoint, which redirects here with
 *    a PKCE code. Exchanged via exchangeCodeForSession. Caveat: the PKCE verifier
 *    lives in a cookie set when the link was REQUESTED, so the link must be opened in
 *    the same browser — acceptable for the normal "request, then click" flow.
 *
 * Either way, on success the earner row is provisioned idempotently and we land in /app.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");

  const supabase = await createServerClient();

  let authed = false;
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    authed = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    authed = !error;
  }

  if (authed) {
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
  return NextResponse.redirect(new URL("/login?error=1", request.url));
}
