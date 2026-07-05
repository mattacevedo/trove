import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

const NAV = [
  { href: "/sponsor", label: "Dashboard" },
  { href: "/sponsor/cohort", label: "Cohort" },
  { href: "/sponsor/skills", label: "Skills" },
  { href: "/sponsor/billing", label: "Billing" },
] as const;

export default async function SponsorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Auth gate only. We intentionally do NOT call requireSponsorAdmin here so that
  // /sponsor/new remains reachable before the user administers any org. Pages that
  // require a sponsor call requireSponsorAdmin() themselves.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-dvh">
      <header className="border-b border-foreground/10 px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center gap-6">
          <span className="font-heading text-xl font-bold">Trove for Sponsors</span>
          <nav aria-label="Sponsor sections" className="flex gap-4">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="min-h-11 inline-flex items-center text-sm font-medium text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
