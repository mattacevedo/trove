import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { CredentialGrid, type WalletCredential } from "@/components/credential-grid";
import { PublicVerifyButton } from "@/components/public-verify-button";

/**
 * Public, unauthenticated verifiable profile (spec §3, §5, §8 screen 3). Enforcement is RLS:
 * earners_public_select / credentials_public_select (0005) only return rows for earners with
 * public_profile_enabled = true. A missing handle and a private earner are indistinguishable —
 * both yield zero rows -> notFound() — which prevents enumerating opted-out earners.
 * The .eq("public_profile_enabled", true) below is defense-in-depth / short-circuit, NOT the boundary.
 */

/**
 * Metadata is resolved via the same anon-RLS path as the page body, so it has the identical
 * missing/disabled parity: a private or nonexistent handle yields a generic title (no earner
 * name leaked into <title>/OG tags), and the page itself still calls notFound() during render.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const supabase = await createServerClient();
  const { data: earner } = await supabase
    .from("earners")
    .select("handle, display_name")
    .eq("handle", handle)
    .eq("public_profile_enabled", true)
    .maybeSingle();

  if (!earner) {
    return { title: "Profile not found | Trove" };
  }

  const name = earner.display_name || earner.handle;
  return {
    title: `${name} | Trove`,
    description: `${name}'s verified skills profile on Trove.`,
  };
}

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const supabase = await createServerClient();

  // Select id so credentials can be keyed by the uuid earner_id column. A uuid is not sensitive.
  const { data: earner } = await supabase
    .from("earners")
    .select("id, handle, display_name")
    .eq("handle", handle)
    .eq("public_profile_enabled", true)
    .maybeSingle();

  if (!earner) notFound();

  // Card fields ONLY — raw_json is NOT selected here (read on-demand by the verify action).
  // storage_path is NOT selected (no anon storage-read policy exists; out of scope).
  const { data } = await supabase
    .from("credentials")
    .select("id, title, issuer_name, issued_date, verification_status")
    .eq("earner_id", earner.id)
    .order("created_at", { ascending: false });
  const credentials = (data ?? []) as WalletCredential[];

  return (
    <div className="min-h-dvh">
      <header className="border-b border-foreground/10 px-4 py-3">
        <span className="font-heading text-xl font-bold">Trove</span>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="mb-2 font-heading text-2xl font-bold">
          {earner.display_name || earner.handle}
        </h1>
        <p className="mb-6 text-sm text-foreground/60">Verified skills profile</p>
        {credentials.length === 0 ? (
          <p className="text-foreground/70">No credentials have been published yet.</p>
        ) : (
          <CredentialGrid
            credentials={credentials}
            renderAction={(c) => (
              <PublicVerifyButton
                handle={earner.handle}
                credentialId={c.id}
                initialStatus={c.verification_status}
              />
            )}
          />
        )}
      </main>
    </div>
  );
}
