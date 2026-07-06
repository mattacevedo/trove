import Link from "next/link";

/* The public front door. Calm-trust house style (design §8): one accent CTA per screen,
   plain reassuring copy, everything reachable by keyboard, nothing behind hover. */

const FEATURES = [
  {
    title: "Verified credentials",
    body: "Import Open Badges and digital credentials by link or file — or add paper certificates by hand. Every credential shows an honest verification state you can re-check any time.",
  },
  {
    title: "A real skills profile",
    body: "Your credentials are translated into a skills profile grounded in O*NET, the U.S. Department of Labor's public skills framework — a common language employers and programs understand.",
  },
  {
    title: "An advisor that knows you",
    body: "Ask what jobs fit your skills, what to learn next, and how to get there. Guidance is grounded in your verified credentials — not guesses.",
  },
] as const;

export default function Home() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="flex items-center justify-between">
        <span className="font-heading text-xl font-bold">Trove</span>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center rounded-md px-3 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Sign in
        </Link>
      </header>

      <main>
        <section className="py-14">
          <h1 className="font-heading text-4xl font-bold text-foreground">
            Trove
          </h1>
          <p className="mt-4 max-w-xl text-lg text-foreground/80">
            Your credentials, verified — and an AI advisor that turns them into
            your next opportunity.
          </p>
          <Link
            href="/login"
            className="mt-8 inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-6 text-base font-medium text-white transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Create your free wallet
          </Link>
          <p className="mt-3 text-sm text-foreground/70">
            Free for earners. No credit card — just your email.
          </p>
        </section>

        <section aria-labelledby="features-heading" className="pb-10">
          <h2 id="features-heading" className="sr-only">
            What Trove does
          </h2>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <li
                key={f.title}
                className="rounded-lg border border-foreground/15 bg-white p-4"
              >
                <h3 className="font-heading text-base font-semibold">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm text-foreground/80">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="sponsors-heading"
          className="rounded-lg border border-foreground/15 bg-white p-6"
        >
          <h2 id="sponsors-heading" className="font-heading text-lg font-semibold">
            Run a workforce or education program?
          </h2>
          <p className="mt-2 max-w-xl text-sm text-foreground/80">
            Invite your cohort, see engagement and consented skills coverage,
            and report outcomes to your funder — while every learner keeps
            ownership of their own wallet.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Sign in to open the sponsor console
          </Link>
        </section>
      </main>

      <footer className="py-10 text-sm text-foreground/60">
        Trove holds and verifies credentials issued by others — it never issues
        its own. Advisor answers are guidance, not a guarantee.
      </footer>
    </div>
  );
}
