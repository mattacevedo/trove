import Link from "next/link";
import { createAdvisorThread } from "@/app/app/advisor/actions";
import { Button } from "@/components/ui/button";
import type { AdvisorThreadSummary } from "@/lib/advisor/types";

export function ThreadList({
  threads,
  activeThreadId,
}: {
  threads: AdvisorThreadSummary[];
  activeThreadId: string | null;
}) {
  return (
    <nav aria-label="Conversations" className="flex flex-col gap-2">
      <form action={createAdvisorThread}>
        <Button type="submit" variant="secondary" className="w-full">
          New conversation
        </Button>
      </form>
      <ul className="flex flex-col gap-1">
        {threads.map((t) => (
          <li key={t.id}>
            <Link
              href={`/app/advisor/${t.id}`}
              aria-current={t.id === activeThreadId ? "page" : undefined}
              className={
                "block rounded-md px-3 py-2 text-sm " +
                (t.id === activeThreadId ? "bg-foreground/10 font-medium" : "hover:bg-foreground/5")
              }
            >
              {t.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
