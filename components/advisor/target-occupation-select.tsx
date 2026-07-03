"use client";

import { useRef } from "react";
import { setTargetOccupation } from "@/app/app/advisor/actions";

export function TargetOccupationSelect({
  occupations,
  selectedId,
}: {
  occupations: { id: string; name: string }[];
  selectedId: string | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={setTargetOccupation} className="flex flex-col gap-1">
      <label htmlFor="target-occupation" className="text-sm font-medium">
        Target occupation
      </label>
      <select
        id="target-occupation"
        name="skill_id"
        defaultValue={selectedId ?? ""}
        onChange={() => formRef.current?.requestSubmit()}
        className="min-h-11 rounded-md border border-foreground/20 px-2"
      >
        <option value="">None set</option>
        {occupations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </form>
  );
}
