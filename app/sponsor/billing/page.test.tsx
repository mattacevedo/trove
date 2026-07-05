import { render, screen, within } from "@testing-library/react";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-sponsor-admin", () => ({
  requireSponsorAdmin: vi.fn(async () => ({ userId: "u1", sponsorId: "sp1" })),
}));

// The server actions are referenced only as <form action={...}> handlers — stub them so the
// page imports without pulling in the real "use server" module (which reaches for Stripe/env).
vi.mock("@/app/sponsor/actions", () => ({
  startCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
}));

const listInvoicesMock = vi.fn();
vi.mock("@/lib/billing/portal", () => ({
  listInvoices: (...args: unknown[]) => listInvoicesMock(...args),
}));
vi.mock("@/lib/billing/stripe", () => ({
  createStripeClient: vi.fn(() => ({ __fake: "stripe" })),
}));

// Fake Supabase returning the sponsor's billing row for the .from("sponsors")…single() read.
let sponsorRow: Record<string, unknown>;
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: sponsorRow, error: null })),
        })),
      })),
    })),
  })),
}));

import BillingPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  listInvoicesMock.mockResolvedValue([]);
});

test("no subscription shows the plan summary and a Checkout call-to-action (no Portal button)", async () => {
  sponsorRow = {
    plan: "free",
    subscription_status: "inactive",
    seats: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null, // no subscription -> Checkout CTA
  };
  const ui = await BillingPage();
  render(ui);

  // Summary surfaces plan + status as text (never color-only).
  expect(screen.getByText(/inactive/i)).toBeInTheDocument();
  // Checkout button present, Manage-billing button absent.
  expect(screen.getByRole("button", { name: /start subscription|checkout/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /manage billing/i })).toBeNull();
  // No invoices → empty state, no table.
  expect(screen.getByText(/no invoices yet/i)).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("active subscription shows a Manage-billing button and an invoices table", async () => {
  sponsorRow = {
    plan: "team",
    subscription_status: "active",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_active",
  };
  listInvoicesMock.mockResolvedValue([
    {
      id: "in_2",
      status: "paid",
      amountPaid: 4900,
      hostedUrl: "https://invoice.stripe.test/in_2",
      created: 1717200000,
    },
  ]);

  const ui = await BillingPage();
  render(ui);

  expect(screen.getByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /start subscription|checkout/i })).toBeNull();

  const table = screen.getByRole("table", { name: /invoices/i });
  // Amount rendered as currency, status as text, and an external link to the hosted invoice.
  expect(within(table).getByText("$49.00")).toBeInTheDocument();
  expect(within(table).getByText(/paid/i)).toBeInTheDocument();
  const link = within(table).getByRole("link", { name: /view/i });
  expect(link).toHaveAttribute("href", "https://invoice.stripe.test/in_2");
});

test("past_due subscription (exists but not active) shows Manage-billing (Portal), NOT Start subscription (F13)", async () => {
  sponsorRow = {
    plan: "team",
    subscription_status: "past_due",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_pastdue", // a subscription EXISTS -> fix it in the Portal
  };
  const ui = await BillingPage();
  render(ui);

  expect(screen.getByText(/past.?due/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  // Must NOT offer to start a second subscription.
  expect(screen.queryByRole("button", { name: /start subscription|checkout/i })).toBeNull();
});
