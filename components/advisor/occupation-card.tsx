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
        // Safety-critical flag: keep the label on text-foreground for WCAG-AA 4.5:1 contrast
        // (amber #d97706 at 12px is only ~3.2:1) and carry the amber cue on the ⚠ icon, which as
        // a graphical object clears the 3:1 non-text threshold. Meaning never rides on color alone.
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-foreground">
          <span aria-hidden="true" className="text-[var(--color-unverified)]">⚠</span> Based partly
          on an unverified credential
        </p>
      )}
    </article>
  );
}
