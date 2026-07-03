"use client";

import { Button } from "@/components/ui/button";

const PROMPTS = [
  "What jobs fit my skills?",
  "What should I learn next?",
  "How do I get there?",
];

export function StarterPrompts({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Suggested prompts">
      {PROMPTS.map((p) => (
        <Button key={p} type="button" variant="secondary" onClick={() => onPick(p)}>
          {p}
        </Button>
      ))}
    </div>
  );
}
