import { render, screen } from "@testing-library/react";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-sponsor-admin", () => ({
  requireSponsorAdmin: vi.fn(async () => ({ userId: "u1", sponsorId: "sp1" })),
}));

// CohortInviteForm/CohortRosterTable pull in the real server action module ("use server", which
// reaches for Postmark/Stripe env) — stub the page's direct children so the page test stays focused
// on the page's own searchParams-driven feedback banner, matching the convention in
// app/sponsor/new/page.test.tsx and app/sponsor/billing/page.test.tsx (stubbing @/app/sponsor/actions).
vi.mock("@/components/sponsor/cohort-invite-form", () => ({
  CohortInviteForm: () => <div data-testid="invite-form" />,
}));
vi.mock("@/components/sponsor/cohort-roster-table", () => ({
  CohortRosterTable: () => <div data-testid="roster-table" />,
}));

let invites: Array<Record<string, unknown>>;
let members: Array<Record<string, unknown>>;
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            order: vi.fn(async () => ({ data: table === "cohort_invites" ? invites : [], error: null })),
          })),
          eq: vi.fn(async () => ({ data: table === "cohort_members" ? members : [], error: null })),
        })),
      })),
    })),
  })),
}));

import CohortPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  invites = [];
  members = [];
});

function sp(params: Record<string, string> = {}) {
  return Promise.resolve(params);
}

test("CAUSE H: a successful invite send reports invited/skipped/resent/failed counts", async () => {
  const ui = await CohortPage({
    searchParams: sp({ invited: "2", skipped: "1", resent: "1", failed: "0" }),
  });
  render(ui);

  const status = screen.getByText(/2 invited/i);
  expect(status).toBeInTheDocument();
  expect(status.textContent).toMatch(/1 (already invited|skipped)/i);
  expect(status.textContent).toMatch(/1 resent/i);
});

test("CAUSE H: error=no_valid_emails renders an accessible alert", async () => {
  const ui = await CohortPage({ searchParams: sp({ error: "no_valid_emails" }) });
  render(ui);
  expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
});

test("CAUSE H: error=missing_member renders an accessible alert", async () => {
  const ui = await CohortPage({ searchParams: sp({ error: "missing_member" }) });
  render(ui);
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

test("CAUSE H: error=remove_failed renders an accessible alert", async () => {
  const ui = await CohortPage({ searchParams: sp({ error: "remove_failed" }) });
  render(ui);
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

test("no query params renders neither a status message nor an alert", async () => {
  const ui = await CohortPage({ searchParams: sp() });
  render(ui);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/invited/i)).toBeNull();
});
