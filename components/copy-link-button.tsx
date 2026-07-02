"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Small client island — clipboard access requires "use client". Keyboard-reachable, 44x44 via Button. */
export function CopyLinkButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied!" : "Copy link"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Profile link copied to clipboard" : ""}
      </span>
    </>
  );
}
