import { cn } from "@/lib/cn";
import type { SkillCoverageRow } from "@/lib/billing/types";

export function CoverageBars({ rows }: { rows: SkillCoverageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-foreground/20 p-6 text-center text-sm text-foreground/60">
        No consented skill data yet. Coverage appears once cohort members opt in
        to share their skills.
      </p>
    );
  }

  const max = Math.max(...rows.map((r) => r.memberCount), 1);

  return (
    <div className="space-y-4">
      {/* Decorative visual — the numbers below are the authoritative source. */}
      <div data-testid="coverage-bars" aria-hidden="true" className="space-y-2">
        {rows.map((r) => (
          <div key={r.skillName} className="flex items-center gap-2">
            <span className="w-40 shrink-0 truncate text-sm text-foreground">{r.skillName}</span>
            <span className="h-4 flex-1 overflow-hidden rounded bg-foreground/10">
              <span
                data-testid="bar-fill"
                className="block h-full rounded bg-primary"
                style={{ width: `${Math.round((r.memberCount / max) * 100)}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right text-sm tabular-nums text-foreground">
              {r.memberCount}
            </span>
          </div>
        ))}
      </div>

      {/* Accessible equivalent — the real data table. */}
      <div className="overflow-x-auto">
        <table className={cn("w-full border-collapse text-sm")} aria-label="Skill coverage">
          <thead>
            <tr className="border-b border-foreground/15 text-left">
              <th scope="col" className="px-3 py-2 font-medium">
                Skill
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Members
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.skillName} className="border-b border-foreground/10">
                <td className="px-3 py-2">{r.skillName}</td>
                <td className="px-3 py-2 tabular-nums">{r.memberCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
