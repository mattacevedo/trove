import { listAdvisorThreads } from "@/app/app/advisor/actions";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";
import { getSkillVocabulary } from "@/lib/skills/data";
import { ThreadList } from "@/components/advisor/thread-list";
import { TargetOccupationSelect } from "@/components/advisor/target-occupation-select";
import { DisclaimerBanner } from "@/components/advisor/disclaimer-banner";

export default async function AdvisorPage() {
  const userId = await requireUserId();
  const supabase = await createServerClient();
  const [threads, vocabulary, earner] = await Promise.all([
    listAdvisorThreads(),
    getSkillVocabulary(supabase),
    supabase.from("earners").select("target_occupation_skill_id").eq("id", userId).single(),
  ]);
  const occupations = vocabulary
    .filter((s) => s.type === "occupation")
    .map((s) => ({ id: s.id, name: s.canonical_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectedId = (earner.data?.target_occupation_skill_id as string | null) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:flex-row">
      <aside className="md:w-64 md:shrink-0">
        <TargetOccupationSelect occupations={occupations} selectedId={selectedId} />
        <div className="mt-4">
          <ThreadList threads={threads} activeThreadId={null} />
        </div>
      </aside>
      <main className="flex-1">
        <h1 className="font-heading text-xl font-semibold">AI advisor</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Start a conversation to explore jobs you may qualify for, what to learn next, and how to
          get there.
        </p>
        <div className="mt-4">
          <DisclaimerBanner />
        </div>
      </main>
    </div>
  );
}
