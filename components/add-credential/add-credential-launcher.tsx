"use client";

import { useRef, useState } from "react";
import { AddCredentialDialog } from "./add-credential-dialog";
import { cn } from "@/lib/cn";

// The trigger needs a ref so focus can return to it on dialog close. The repo's
// components/ui/button.tsx types its props as React.ButtonHTMLAttributes & {variant?}, which does
// NOT include `ref` — passing ref={triggerRef} to <Button> is a hard TS2322 error under this
// repo's @types/react@19 + tsconfig. Rather than modify Plan 1's shared Button, we render a native
// <button> here, reusing Button's exact class string so it stays visually identical (primary variant).
const TRIGGER_CLASSES = cn(
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-4 text-base font-medium",
  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
  "disabled:pointer-events-none disabled:opacity-50",
  "bg-primary text-white hover:bg-secondary"
);

export function AddCredentialLauncher({ label }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    triggerRef.current?.focus(); // return focus to the trigger
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={TRIGGER_CLASSES}
        onClick={() => setOpen(true)}
      >
        {label ?? "Add credential"}
      </button>
      {open ? <AddCredentialDialog onClose={close} /> : null}
    </>
  );
}
