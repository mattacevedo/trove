import { notFound } from "next/navigation";
import { listAdvisorThreads, getAdvisorThread } from "@/app/app/advisor/actions";
import { ThreadList } from "@/components/advisor/thread-list";
import { ChatPane } from "@/components/advisor/chat-pane";

export default async function AdvisorThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const [threads, loaded] = await Promise.all([
    listAdvisorThreads(),
    getAdvisorThread(threadId),
  ]);
  if (!loaded) notFound();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:flex-row">
      <aside className="md:w-64 md:shrink-0">
        <ThreadList threads={threads} activeThreadId={threadId} />
      </aside>
      <main className="flex-1">
        <h1 className="font-heading text-lg font-semibold">{loaded.thread.title}</h1>
        {loaded.thread.targetOccupationName && (
          <p className="text-sm text-foreground/70">
            Target: {loaded.thread.targetOccupationName}
          </p>
        )}
        {/* key={threadId} forces a remount on thread switch so ChatPane's
            useState initializers re-seed from the new thread's messages
            (same [threadId] route → React would otherwise reuse the instance). */}
        <ChatPane key={threadId} threadId={threadId} initialMessages={loaded.messages} />
      </main>
    </div>
  );
}
