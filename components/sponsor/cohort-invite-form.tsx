import { inviteCohort } from "@/app/sponsor/actions";
import { Button } from "@/components/ui/button";

/** Labeled roster textarea posting to the inviteCohort server action. WCAG: real <label> tied to
 *  the control via htmlFor/id, keyboard-native textarea + button (min 44px via Button primitive). */
export function CohortInviteForm() {
  return (
    <form action={inviteCohort} className="flex flex-col gap-3">
      <label htmlFor="cohort-emails" className="text-sm font-medium">
        Email addresses
      </label>
      <p id="cohort-emails-hint" className="text-sm text-foreground/70">
        Separate addresses with commas, spaces, or new lines. Already-invited addresses are skipped.
      </p>
      <textarea
        id="cohort-emails"
        name="emails"
        rows={5}
        required
        aria-describedby="cohort-emails-hint"
        className="w-full rounded-md border border-foreground/20 p-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        placeholder="alex@example.com, sam@example.com"
      />
      <div>
        <Button type="submit">Send invites</Button>
      </div>
    </form>
  );
}
