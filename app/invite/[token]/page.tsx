import { createServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "./actions";

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  // Narrow pre-accept preview via the invite_preview SECURITY DEFINER RPC (0009), NOT a direct
  // cohort_invites SELECT: the only RLS policy on cohort_invites (cohort_invites_sponsor_all, 0007)
  // is sponsor-admin-scoped, so a real invitee — unauthenticated or authenticated but not that
  // sponsor's admin — would get zero rows back and always see "Invitation unavailable". The RPC
  // works identically for anon and authenticated callers and returns only the two fields this
  // pre-login preview needs, keyed by the (unguessable) token itself. It returns an array of 0 or 1
  // rows: empty for an unknown/garbage token, never an error.
  const supabase = await createServerClient();
  const { data: rows } = await supabase.rpc("invite_preview", { invite_token: token });
  const preview = (rows as Array<{ sponsor_name: string; is_open: boolean }> | null)?.[0];

  const sponsorName = preview?.sponsor_name;
  const isOpen = !!preview && preview.is_open && !!sponsorName;

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      {isOpen ? (
        <>
          <h1 className="font-heading text-3xl font-bold">{sponsorName} invited you to Trove</h1>
          <p className="mt-4 text-foreground/80">
            Accepting shares nothing automatically. You control what {sponsorName} can see from your
            wallet — consent is off until you turn it on.
          </p>
          {error ? (
            <p className="mt-4 text-sm text-[var(--color-failed)]" role="alert">
              We couldn&apos;t accept this invitation. It may have expired. Please ask for a new one.
            </p>
          ) : null}
          <form action={acceptInvite} className="mt-6">
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">
              Accept invitation
            </Button>
          </form>
          <p className="mt-3 text-sm text-foreground/60">
            You&apos;ll be asked to sign in first if you don&apos;t have an account yet.
          </p>
        </>
      ) : (
        <>
          <h1 className="font-heading text-3xl font-bold">Invitation unavailable</h1>
          <p className="mt-4 text-foreground/80">
            This invitation is no longer valid. It may have already been accepted or expired. Ask
            your program for a fresh link.
          </p>
        </>
      )}
    </main>
  );
}
