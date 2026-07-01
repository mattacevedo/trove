import { AddCredentialLauncher } from "@/components/add-credential/add-credential-launcher";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_url: "That does not look like a valid URL. Paste the full https:// address.",
  fetch_failed: "We could not reach that URL. Check the link and try again.",
  invalid_json: "That URL did not return valid JSON.",
  unrecognized_credential: "That URL did not return a recognizable credential.",
  no_file: "Choose a badge file to upload.",
  bad_type: "That file type is not supported. Use JSON, PNG, or SVG.",
  too_large: "That file is too large (5 MB max).",
  missing_title: "A title is required for a manual credential.",
};

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] : null;
  return (
    <div className="mx-auto max-w-md">
      <h1 className="font-heading text-2xl font-bold">Add a credential</h1>
      <p className="mt-2 text-foreground/70">
        Import by URL, upload a badge file, or enter one manually.
      </p>
      {message ? (
        <p className="mt-4 text-sm text-[var(--color-failed)]" role="alert">
          {message}
        </p>
      ) : null}
      <div className="mt-6">
        <AddCredentialLauncher label="Add credential" />
      </div>
    </div>
  );
}
