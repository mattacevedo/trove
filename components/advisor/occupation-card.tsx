import type { OccupationGap } from "@/lib/advisor/types";

export function OccupationCard({
  gap,
  reliesOnUnverified = false,
}: {
  gap: OccupationGap;
  reliesOnUnverified?: boolean;
}) {
  return (
    <article className="rounded-lg border border-foreground/15 bg-white p-4">
      <h3 className="font-heading text-base font-semibold">{gap.occupationName}</h3>
      <p className="mt-1 text-sm">
        You have <strong>{gap.haveCount}</strong> of <strong>{gap.totalCount}</strong> skills (
        {gap.coveragePct}%).
      </p>
      {gap.missingSkillNames.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Missing skills">
          {gap.missingSkillNames.map((name) => (
            <li
              key={name}
              className="rounded-full border border-foreground/20 px-2 py-0.5 text-xs"
            >
              {name}
            </li>
          ))}
        </ul>
      )}
      {reliesOnUnverified && (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--color-unverified)]">
          <span aria-hidden="true">⚠</span> Based partly on an unverified credential
        </p>
      )}
    </article>
  );
}
