import { AddCredentialLauncher } from "@/components/add-credential/add-credential-launcher";

export function EmptyWalletState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-foreground/20 px-4 py-16 text-center">
      <h2 className="font-heading text-xl font-semibold">Your wallet is empty</h2>
      <p className="max-w-sm text-foreground/70">
        Add your certificates, badges, and licenses to build a verifiable skills profile.
      </p>
      <AddCredentialLauncher label="Add your first credential" />
    </div>
  );
}
