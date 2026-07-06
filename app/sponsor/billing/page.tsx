import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createServerClient } from "@/lib/supabase/server";
import { createStripeClient } from "@/lib/billing/stripe";
import { listInvoices } from "@/lib/billing/portal";
import { startCheckout, openBillingPortal } from "@/app/sponsor/actions";
import { Button } from "@/components/ui/button";
import type { BillingSummary } from "@/lib/billing/types";

/** Cents → "$49.00". */
function formatAmount(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    cents / 100
  );
}

/** Unix seconds → "Jun 1, 2026". */
function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime())
    ? String(unixSeconds)
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string }>;
}) {
  const { sponsorId } = await requireSponsorAdmin();
  const { checkout, error } = await searchParams;
  const supabase = await createServerClient();

  const { data: row } = await supabase
    .from("sponsors")
    .select("plan, subscription_status, seats, stripe_customer_id, stripe_subscription_id")
    .eq("id", sponsorId)
    .single();

  const stripeCustomerId = (row?.stripe_customer_id as string | null) ?? null;
  const summary: BillingSummary = {
    plan: (row?.plan as string | null) ?? "free",
    subscriptionStatus: (row?.subscription_status as string | null) ?? "inactive",
    seats: (row?.seats as number | null) ?? 0,
    stripeCustomerId,
  };

  // F13: the Checkout CTA appears ONLY when there is NO subscription at all. A subscription that
  // exists but is not active (past_due/incomplete) must route to the Portal to FIX payment, never
  // start a second subscription — so the button choice keys on stripe_subscription_id, not status.
  const hasSubscription = ((row?.stripe_subscription_id as string | null) ?? null) !== null;

  // CAUSE H: Stripe redirects the admin back to ?checkout=success as soon as Checkout completes, but
  // the webhook that actually populates stripe_subscription_id (customer.subscription.created) can
  // land moments later — a real race, not a hypothetical one. Showing the normal Checkout CTA in that
  // window would let the admin start a SECOND subscription; showing nothing would look like the
  // payment silently vanished. Render an explicit "activating" message and suppress the CTA instead.
  const activating = checkout === "success" && !hasSubscription;

  // CAUSE I: only construct a Stripe client / call listInvoices when the sponsor actually has a
  // Stripe customer — createStripeClient() throws (`new Stripe("")`) when STRIPE_SECRET_KEY is unset,
  // and a sponsor with no stripe_customer_id has no invoices to list regardless.
  const invoices = stripeCustomerId
    ? await listInvoices(createStripeClient(), supabase, sponsorId)
    : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Your subscription bills per active seat. Manage payment details in the Stripe portal.
        </p>
      </header>

      {activating ? (
        <p
          role="status"
          className="rounded-lg border border-foreground/15 bg-white p-4 text-sm text-foreground/80"
        >
          Payment received — activating your subscription…
        </p>
      ) : null}
      {checkout === "cancel" ? (
        <p className="rounded-lg border border-foreground/15 bg-white p-4 text-sm" role="alert">
          Checkout was canceled — no changes were made to your subscription.
        </p>
      ) : null}
      {error === "price_not_configured" ? (
        <p className="rounded-lg border border-foreground/15 bg-white p-4 text-sm" role="alert">
          Billing isn&apos;t configured yet. Please contact support.
        </p>
      ) : null}

      <section
        aria-label="Subscription summary"
        className="grid grid-cols-1 gap-4 rounded-lg border border-foreground/15 bg-white p-4 sm:grid-cols-3"
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground/70">Plan</span>
          <span className="font-heading text-lg font-semibold capitalize">{summary.plan}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground/70">Status</span>
          <span className="inline-flex items-center gap-1 font-heading text-lg font-semibold capitalize">
            <span aria-hidden="true">{summary.subscriptionStatus === "active" ? "✓" : "○"}</span>
            {summary.subscriptionStatus}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground/70">Active seats</span>
          <span className="font-heading text-lg font-semibold tabular-nums">{summary.seats}</span>
        </div>
      </section>

      <section aria-label="Subscription actions">
        {hasSubscription ? (
          <form action={openBillingPortal}>
            <Button type="submit">Manage billing</Button>
          </form>
        ) : activating ? null : (
          <form action={startCheckout}>
            <Button type="submit">Start subscription</Button>
          </form>
        )}
      </section>

      <section aria-label="Invoices" className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="rounded-lg border border-dashed border-foreground/20 p-6 text-center text-sm text-foreground/60">
            No invoices yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" aria-label="Invoices">
              <thead>
                <tr className="border-b border-foreground/15 text-left">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Invoice
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-foreground/10">
                    <td className="px-3 py-2 tabular-nums">{formatDate(inv.created)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatAmount(inv.amountPaid)}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1 capitalize">
                        <span aria-hidden="true">{inv.status === "paid" ? "✓" : "•"}</span>
                        {inv.status ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {inv.hostedUrl ? (
                        <a
                          href={inv.hostedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                        >
                          View
                          <span className="sr-only"> invoice (opens in a new tab)</span>
                        </a>
                      ) : (
                        <span className="text-foreground/50">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
