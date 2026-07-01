"use client";

import { useTransition } from "react";
import { reverifyCredential } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

export function ReverifyButton({ credentialId }: { credentialId: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => startTransition(() => reverifyCredential(formData))}
    >
      <input type="hidden" name="credential_id" value={credentialId} />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? "Verifying…" : "Re-verify"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {isPending ? "Verifying credential" : ""}
      </span>
    </form>
  );
}
