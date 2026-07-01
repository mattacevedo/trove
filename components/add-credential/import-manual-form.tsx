"use client";

import { useState } from "react";
import { importManual } from "@/app/app/wallet/actions";
import { Button } from "@/components/ui/button";

const field =
  "mt-1 min-h-11 w-full rounded-md border border-foreground/20 px-3 text-base";

export function ImportManualForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={importManual}
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        const title = new FormData(e.currentTarget).get("title");
        if (!String(title ?? "").trim()) {
          e.preventDefault();
          setError("Title is required.");
        } else {
          setError(null);
        }
      }}
    >
      <div>
        <label htmlFor="m-title" className="block text-sm font-medium">
          Title
        </label>
        <input id="m-title" name="title" required className={field} />
      </div>
      <div>
        <label htmlFor="m-issuer" className="block text-sm font-medium">
          Issuer
        </label>
        <input id="m-issuer" name="issuer_name" className={field} />
      </div>
      <div>
        <label htmlFor="m-date" className="block text-sm font-medium">
          Date earned
        </label>
        <input id="m-date" name="issued_date" type="date" className={field} />
      </div>
      <div>
        <label htmlFor="m-desc" className="block text-sm font-medium">
          Description
        </label>
        <textarea id="m-desc" name="description" rows={3} className={field} />
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
