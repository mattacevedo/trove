"use client";

import { useState } from "react";
import { importByFile } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ".json,.png,.svg,application/json,image/png,image/svg+xml";

export function ImportByFileForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={importByFile}
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        const file = new FormData(e.currentTarget).get("file");
        if (!(file instanceof File) || file.size === 0) {
          e.preventDefault();
          setError("Choose a badge file (.json, .png, or .svg).");
        } else if (file.size > MAX_BYTES) {
          e.preventDefault();
          setError("File is too large (5 MB max).");
        } else {
          setError(null);
        }
      }}
    >
      <div>
        <label htmlFor="f-file" className="block text-sm font-medium">
          Badge file
        </label>
        <input
          id="f-file"
          name="file"
          type="file"
          accept={ACCEPT}
          required
          className="mt-1 min-h-11 w-full rounded-md border border-foreground/20 px-3 py-2 text-base"
        />
        <p className="mt-1 text-sm text-foreground/60">
          Open Badges JSON, or a baked PNG / SVG badge. Some badge images don&apos;t include
          embedded data — if yours doesn&apos;t import, paste its URL or add it manually.
        </p>
      </div>
      {error ? (
        <p className="text-sm text-[var(--color-failed)]" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full">
        Add credential
      </Button>
    </form>
  );
}
