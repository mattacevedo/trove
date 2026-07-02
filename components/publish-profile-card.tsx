import { updatePublicProfileEnabled } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/copy-link-button";

/**
 * Publish control for the wallet home. Read-only handle (editing is out of Plan 4 scope).
 * The toggle is a plain server-actioned <form> (no client JS state) mirroring ReverifyButton:
 * a single hidden `enabled` input carries the NEXT state, so one click flips the flag.
 */
export function PublishProfileCard({
  handle,
  publicProfileEnabled,
}: {
  handle: string;
  publicProfileEnabled: boolean;
}) {
  const nextState = publicProfileEnabled ? "false" : "true";
  const profilePath = `/u/${handle}`;

  return (
    <section
      aria-labelledby="publish-heading"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-foreground/10 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="publish-heading" className="font-heading text-lg font-semibold">
          Publish profile
        </h2>
        <span className="text-sm font-medium text-foreground/70">
          {publicProfileEnabled ? "Public" : "Private"}
        </span>
      </div>

      <p className="text-sm text-foreground/70">
        {publicProfileEnabled
          ? "Anyone with your link can view ALL of your credentials — current and future — and re-verify them against the issuer. Publishing is all-or-nothing; there is no per-credential control yet."
          : "Your credentials are private. Publishing shares ALL of your credentials (current and future) as a verifiable profile at a public link — no account needed to view it. It is all-or-nothing; you cannot yet choose individual credentials."}
      </p>

      {publicProfileEnabled ? (
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded bg-foreground/5 px-2 py-1 text-sm">{profilePath}</code>
          <CopyLinkButton value={profilePath} />
        </div>
      ) : null}

      <form action={updatePublicProfileEnabled} className="mt-1">
        <input type="hidden" name="enabled" value={nextState} />
        <Button type="submit" variant={publicProfileEnabled ? "secondary" : "primary"}>
          {publicProfileEnabled ? "Make private" : "Publish (make public)"}
        </Button>
      </form>
    </section>
  );
}
