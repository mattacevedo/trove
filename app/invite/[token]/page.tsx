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

  // Narrow pre-accept read: resolve the sponsor's name for a friendly prompt.
  // A missing/accepted invite yields no usable name -> "no longer valid".
  const supabase = await createServerClient();
  const { data: invite } = await supabase
    .from("cohort_invites")
    .select("accepted_at, sponsors(name)")
    .eq("token", token)
    .maybeSingle();

  const sponsor = invite?.sponsors as { name: string } | { name: string }[] | null | undefined;
  const sponsorName = Array.isArray(sponsor) ? sponsor[0]?.name : sponsor?.name;
  const isOpen = !!invite && !invite.accepted_at && !!sponsorName;

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
