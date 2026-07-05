import { render, screen } from "@testing-library/react";
import { expect, test, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above module scope, so a plain top-level `const` mock fn would be
// referenced before initialization. vi.hoisted lifts these alongside the mocks (matching the
// pattern in app/sponsor/actions.invite.test.ts and components/advisor/chat-pane.test.tsx).
const { requireSponsorAdmin, getSponsorSkillCoverage, createServerClient } = vi.hoisted(() => ({
  requireSponsorAdmin: vi.fn(),
  getSponsorSkillCoverage: vi.fn(),
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/auth/require-sponsor-admin", () => ({ requireSponsorAdmin }));
vi.mock("@/lib/billing/skill-coverage", () => ({ getSponsorSkillCoverage }));
vi.mock("@/lib/supabase/server", () => ({ createServerClient }));

import SkillsPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  requireSponsorAdmin.mockResolvedValue({ userId: "u1", sponsorId: "s1" });
  createServerClient.mockResolvedValue({ __db: true });
  getSponsorSkillCoverage.mockResolvedValue([
    { skillName: "Python", memberCount: 5 },
  ]);
});

test("gates on requireSponsorAdmin and renders coverage for that sponsor", async () => {
  render(await SkillsPage());
  expect(requireSponsorAdmin).toHaveBeenCalledOnce();
  expect(getSponsorSkillCoverage).toHaveBeenCalledWith({ __db: true }, "s1");
  // Rendered via CoverageBars' table.
  expect(screen.getByRole("cell", { name: "Python" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "5" })).toBeInTheDocument();
});

test("renders a page heading", async () => {
  render(await SkillsPage());
  expect(
    screen.getByRole("heading", { name: /skill coverage/i })
  ).toBeInTheDocument();
});
