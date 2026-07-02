import type { ReactNode } from "react";
import { CredentialCard, type WalletCredential } from "@/components/credential-card";

export type { WalletCredential };

export function CredentialGrid({
  credentials,
  renderAction,
}: {
  credentials: WalletCredential[];
  renderAction?: (credential: WalletCredential) => ReactNode;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {credentials.map((c) => (
        <CredentialCard key={c.id} credential={c} action={renderAction?.(c)} />
      ))}
    </ul>
  );
}
