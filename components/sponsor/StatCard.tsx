import { cn } from "@/lib/cn";

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    // role="group" + aria-label gives the card one accessible name ("Invited, 12"),
    // so meaning never rides on layout/color alone.
    <div
      role="group"
      aria-label={`${label}: ${value}`}
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-foreground/15 bg-white p-4"
      )}
    >
      <span className="text-sm font-medium text-foreground/70">{label}</span>
      <span className="font-heading text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </span>
      {hint && <span className="text-xs text-foreground/60">{hint}</span>}
    </div>
  );
}
