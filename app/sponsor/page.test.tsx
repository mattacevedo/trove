import { render, screen, within } from "@testing-library/react";
import { expect, test, vi, beforeEach } from "vitest";

// Mock the auth gate, the engagement layer, and the Supabase client so the page
// renders without touching a real DB, network, or Stripe.
vi.mock("@/lib/auth/require-sponsor-admin", () => ({
  requireSponsorAdmin: vi.fn(async () => ({ userId: "u1", sponsorId: "sp1" })),
}));
vi.mock("@/lib/billing/engagement", () => ({
  getSponsorEngagement: vi.fn(async () => ({
    invited: 10,
    activated: 6,
    imported: 4,
    advisorUsed: 2,
  })),
}));

const memberRows = [
  {
    handle: "ada",
    status: "active",
    consent_share_skills: true,
    consent_share_credentials: false,
    invited_at: "2026-03-01T00:00:00.000Z",
    earners: { handle: "ada" },
  },
];

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(async () => ({ data: memberRows, error: null })),
        })),
      })),
    })),
  })),
}));

import SponsorPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
});

test("renders four funnel stat cards from engagement metrics", async () => {
  const ui = await SponsorPage();
  render(ui);
  expect(screen.getByRole("group", { name: /invited: 10/i })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /activated: 6/i })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /imported: 4/i })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /advisor used: 2/i })).toBeInTheDocument();
});

test("renders the member table with the mocked cohort row", async () => {
  const ui = await SponsorPage();
  render(ui);
  const table = screen.getByRole("table", { name: /cohort members/i });
  expect(within(table).getByText("@ada")).toBeInTheDocument();
  // Consent surfaced as text, credential/skill detail never fetched.
  expect(within(table).getAllByText("Yes").length).toBeGreaterThanOrEqual(1);
  expect(within(table).getAllByText("No").length).toBeGreaterThanOrEqual(1);
});
