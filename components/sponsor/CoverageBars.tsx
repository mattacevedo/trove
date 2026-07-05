import { cn } from "@/lib/cn";
import type { SkillCoverageRow } from "@/lib/billing/types";

export function CoverageBars({ rows }: { rows: SkillCoverageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-600">
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
            <span className="w-40 shrink-0 truncate text-sm">{r.skillName}</span>
            <span className="h-4 flex-1 overflow-hidden rounded bg-gray-100">
              <span
                data-testid="bar-fill"
                className="block h-full rounded bg-[var(--color-primary,#2563EB)]"
                style={{ width: `${Math.round((r.memberCount / max) * 100)}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right text-sm tabular-nums">
              {r.memberCount}
            </span>
          </div>
        ))}
      </div>

      {/* Accessible equivalent — the real data table. */}
      <table className={cn("w-full border-collapse text-sm")}>
        <caption className="sr-only">Skill coverage across consenting members</caption>
        <thead>
          <tr className="border-b border-gray-200 text-left">
            <th scope="col" className="py-2 pr-4 font-medium">
              Skill
            </th>
            <th scope="col" className="py-2 font-medium">
              Members
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.skillName} className="border-b border-gray-100">
              <td className="py-2 pr-4">{r.skillName}</td>
              <td className="py-2 tabular-nums">{r.memberCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
