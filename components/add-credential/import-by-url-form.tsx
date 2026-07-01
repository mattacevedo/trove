"use client";

import { useState } from "react";
import { importByUrl } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

export function ImportByUrlForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={importByUrl}
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        const url = String(new FormData(e.currentTarget).get("url") ?? "").trim();
        if (!url) {
          e.preventDefault();
          setError("Paste a credential URL.");
        } else {
          setError(null);
        }
      }}
    >
      <div>
        <label htmlFor="u-url" className="block text-sm font-medium">
          Credential URL
        </label>
        <input
          id="u-url"
          name="url"
          type="url"
          inputMode="url"
          placeholder="https://issuer.example/badge.json"
          required
          className="mt-1 min-h-11 w-full rounded-md border border-foreground/20 px-3 text-base"
        />
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
