"use client";

import { useState, useTransition } from "react";
import { sendAdvisorMessage } from "@/app/app/advisor/actions";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { OccupationCard } from "@/components/advisor/occupation-card";
import { DisclaimerBanner } from "@/components/advisor/disclaimer-banner";
import { StarterPrompts } from "@/components/advisor/starter-prompts";
import type { AdvisorMessage, OccupationCard as OccupationCardData } from "@/lib/advisor/types";

type Bubble = { role: "user" | "assistant"; content: string };

export function ChatPane({
  threadId,
  initialMessages,
}: {
  threadId: string;
  initialMessages: AdvisorMessage[];
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>(
    initialMessages.map((m) => ({ role: m.role, content: m.content }))
  );
  const [cards, setCards] = useState<OccupationCardData[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(text: string) {
    const content = text.trim();
    if (!content || isPending) return;
    setNotice(null);
    setBubbles((b) => [...b, { role: "user", content }]);
    setDraft("");
    startTransition(async () => {
      const res = await sendAdvisorMessage(threadId, content);
      if (res.ok) {
        setBubbles((b) => [...b, { role: "assistant", content: res.message.content }]);
        setCards(res.occupationCards);
      } else if (res.reason === "rate_limited") {
        setNotice("You've reached today's advisor limit — more tomorrow.");
      } else if (res.reason === "empty_message") {
        setNotice("Please enter a message.");
      } else {
        setNotice("This conversation could not be found.");
      }
    });
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      <DisclaimerBanner />

      {bubbles.length === 0 && <StarterPrompts onPick={submit} />}

      <div
        className="flex flex-col gap-2"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
      >
        {bubbles.map((m, i) => (
          <MessageBubble key={i} role={m.role} content={m.content} />
        ))}
      </div>

      {cards.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cards.map((c) => (
            <OccupationCard
              key={c.gap.occupationId}
              gap={c.gap}
              reliesOnUnverified={c.reliesOnUnverified}
            />
          ))}
        </div>
      )}

      <span className="sr-only" role="status" aria-live="polite">
        {isPending ? "Advisor is responding" : ""}
      </span>
      {notice && (
        <p role="alert" className="text-sm text-[var(--color-failed)]">
          {notice}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="flex gap-2"
      >
        <label htmlFor="advisor-input" className="sr-only">
          Message the advisor
        </label>
        <input
          id="advisor-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={isPending}
          placeholder="Ask about jobs, skills, or next steps…"
          className="min-h-11 flex-1 rounded-md border border-foreground/20 px-3"
        />
        <Button type="submit" disabled={isPending || !draft.trim()}>
          {isPending ? "Sending…" : "Send"}
        </Button>
      </form>
    </div>
  );
}
