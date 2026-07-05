"use client";

import { useTransition } from "react";
import { removeMember } from "@/app/sponsor/actions";
import { Button } from "@/components/ui/button";

/**
 * Removes a single cohort member (soft delete -> status='removed' + Stripe seat sync via the
 * removeMember server action). A native window.confirm() gate names the member being removed so a
 * misclick can't silently drop someone from the roster — this is a destructive, billing-affecting
 * action. Keyboard-reachable and >=44px via the Button primitive (WCAG-AA).
 */
export function RemoveMemberButton({ earnerId, email }: { earnerId: string; email: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => {
        if (!window.confirm(`Remove ${email} from this cohort? They will lose access to sponsor-only benefits.`)) {
          return;
        }
        startTransition(() => removeMember(formData));
      }}
    >
      <input type="hidden" name="earnerId" value={earnerId} />
      <Button type="submit" variant="secondary" disabled={isPending}>
        {isPending ? "Removing…" : "Remove"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {isPending ? `Removing ${email}` : ""}
      </span>
    </form>
  );
}
