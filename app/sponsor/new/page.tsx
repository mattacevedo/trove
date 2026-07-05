import { createSponsor } from "@/app/sponsor/actions";
import { Button } from "@/components/ui/button";

export default function SponsorNewPage() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="font-heading text-2xl font-bold">Create your organization</h1>
      <p className="mt-2 text-sm text-foreground/70">
        Set up a sponsor workspace to invite a cohort, track engagement, and manage billing.
      </p>
      <form action={createSponsor} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="sponsor-name" className="text-sm font-medium">
            Organization name
          </label>
          <input
            id="sponsor-name"
            name="name"
            type="text"
            required
            autoComplete="organization"
            className="min-h-11 rounded-md border border-foreground/20 px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          />
        </div>
        <Button type="submit" variant="primary" className="self-start">
          Create organization
        </Button>
      </form>
    </div>
  );
}
