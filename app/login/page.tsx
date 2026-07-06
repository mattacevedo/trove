import { sendOtp } from "./actions";
import { Button } from "@/components/ui/button";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 id="login-heading" className="font-heading text-3xl font-bold">Sign in to Trove</h1>
      {params.sent ? (
        <p className="mt-4 text-foreground/80" role="status">
          Check your email for a sign-in link.
        </p>
      ) : (
        <form action={sendOtp} aria-labelledby="login-heading" className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mt-1 min-h-11 w-full rounded-md border border-foreground/20 px-3 text-base"
            />
          </div>
          {params.error ? (
            <p className="text-sm text-[var(--color-failed)]" role="alert">
              {params.error === "rate_limited"
                ? "Too many sign-in emails in the past hour. Please wait a little while and try again."
                : "Something went wrong. Please try again."}
            </p>
          ) : null}
          <Button type="submit" className="w-full">
            Email me a sign-in link
          </Button>
        </form>
      )}
    </main>
  );
}
