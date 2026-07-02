import { createServerClient } from "@/lib/supabase/server";
import { CredentialGrid, type WalletCredential } from "@/components/credential-grid";
import { EmptyWalletState } from "@/components/empty-wallet-state";
import { AddCredentialLauncher } from "@/components/add-credential/add-credential-launcher";
import { PublishProfileCard } from "@/components/publish-profile-card";

export default async function WalletHome() {
  const supabase = await createServerClient();
  // RLS (credentials_owner_all) scopes this to the signed-in earner — no manual filter needed.
  const { data } = await supabase
    .from("credentials")
    .select("id, title, issuer_name, issued_date, verification_status")
    .order("created_at", { ascending: false });
  const credentials = (data ?? []) as WalletCredential[];

  // RLS (earners_self_select) scopes this to the signed-in earner's own row.
  // .maybeSingle() (not .single()) matches the house pattern (lib/auth/provision-earner.ts):
  // a session can reach /app before provisionEarner has run, and .single() would log a spurious
  // PGRST116 error on zero rows; .maybeSingle() returns { data: null } cleanly.
  const { data: earner } = await supabase
    .from("earners")
    .select("handle, public_profile_enabled")
    .maybeSingle();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-bold">My Wallet</h1>
        {credentials.length > 0 ? <AddCredentialLauncher /> : null}
      </div>
      {earner ? (
        <PublishProfileCard
          handle={earner.handle}
          publicProfileEnabled={earner.public_profile_enabled}
        />
      ) : null}
      {credentials.length === 0 ? (
        <EmptyWalletState />
      ) : (
        <CredentialGrid credentials={credentials} />
      )}
    </div>
  );
}
