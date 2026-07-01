import { CredentialCard, type WalletCredential } from "@/components/credential-card";

export type { WalletCredential };

export function CredentialGrid({
  credentials,
}: {
  credentials: WalletCredential[];
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {credentials.map((c) => (
        <CredentialCard key={c.id} credential={c} />
      ))}
    </ul>
  );
}
