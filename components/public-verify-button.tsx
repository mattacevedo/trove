"use client";

import { useState, useTransition } from "react";
import { publicReverifyCredential } from "@/app/u/[handle]/actions";
import { Button } from "@/components/ui/button";
import type { VerifyResult, VerificationStatus } from "@/lib/credentials/types";

const LABEL: Record<VerifyResult["status"], string> = {
  verified: "Verified against the issuer",
  unverified: "Could not be verified automatically",
  failed: "Verification failed",
};

/**
 * Public read-only verify affordance. Calls the display-only publicReverifyCredential action
 * (which never writes, and is scoped to this profile's handle) and shows the transient live result
 * in an aria-live status region. The region is SEEDED with the credential's last-known status
 * (initialStatus) so it is never blank before the visitor clicks "Check now".
 * This REPLACES the write-capable ReverifyButton on the public page.
 */
export function PublicVerifyButton({
  handle,
  credentialId,
  initialStatus,
}: {
  handle: string;
  credentialId: string;
  initialStatus: VerificationStatus;
}) {
  const [isPending, startTransition] = useTransition();
  // Seed with the last-known status so the region shows the current state before any click.
  const [result, setResult] = useState<VerifyResult | null>({
    status: initialStatus,
    method: "none",
    detail: "last known status",
  });

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const res = await publicReverifyCredential(handle, credentialId);
            setResult(res);
          })
        }
      >
        {isPending ? "Checking…" : "Check now"}
      </Button>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-foreground/70">
        {isPending
          ? "Checking against the issuer…"
          : result
            ? LABEL[result.status]
            : ""}
      </p>
    </div>
  );
}
