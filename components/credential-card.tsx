import type { ReactNode } from "react";
import { VerificationBadge } from "@/components/verification-badge";
import { ReverifyButton } from "@/components/reverify-button";

export interface WalletCredential {
  id: string;
  title: string;
  issuer_name: string;
  issued_date: string | null;
  verification_status: "verified" | "unverified" | "failed";
}

function formatDate(iso: string | null): string {
  if (!iso) return "Date not provided";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "Date not provided";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function CredentialCard({
  credential,
  action,
}: {
  credential: WalletCredential;
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-foreground/10 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-heading text-lg font-semibold leading-snug">
          {credential.title || "Untitled credential"}
        </h3>
        <VerificationBadge status={credential.verification_status} />
      </div>
      <p className="text-sm text-foreground/80">
        {credential.issuer_name || "Unknown issuer"}
      </p>
      <p className="text-sm text-foreground/60">{formatDate(credential.issued_date)}</p>
      <div className="mt-auto pt-2">
        {/* Default = write-capable ReverifyButton (wallet). Public page injects a read-only action. */}
        {action ?? <ReverifyButton credentialId={credential.id} />}
      </div>
    </li>
  );
}
