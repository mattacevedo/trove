import { BadgeCheck, CircleAlert, CircleX } from "lucide-react";
import { cn } from "@/lib/cn";

type Status = "verified" | "unverified" | "failed";

const config: Record<
  Status,
  { label: string; icon: typeof BadgeCheck; className: string }
> = {
  verified: {
    label: "Verified",
    icon: BadgeCheck,
    className: "text-[var(--color-verified)] border-[var(--color-verified)]",
  },
  unverified: {
    label: "Unverified",
    icon: CircleAlert,
    className: "text-[var(--color-unverified)] border-[var(--color-unverified)]",
  },
  failed: {
    label: "Verification failed",
    icon: CircleX,
    className: "text-[var(--color-failed)] border-[var(--color-failed)]",
  },
};

export function VerificationBadge({ status }: { status: Status }) {
  const { label, icon: Icon, className } = config[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-medium",
        className
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </span>
  );
}
