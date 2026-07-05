import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CohortRosterTable } from "./cohort-roster-table";

vi.mock("@/app/sponsor/actions", () => ({ removeMember: vi.fn() }));

test("renders members and pending invites with status text (no color-only signalling)", () => {
  render(
    <CohortRosterTable
      rows={[
        { email: "member@x.com", status: "active", accepted: true },
        { email: "pending@x.com", status: "invited", accepted: false },
      ]}
    />
  );
  expect(screen.getByText("member@x.com")).toBeInTheDocument();
  expect(screen.getByText("pending@x.com")).toBeInTheDocument();
  expect(screen.getByText(/active/i)).toBeInTheDocument();
  expect(screen.getByText("Invite sent")).toBeInTheDocument();
  // The table has a caption or column header for accessibility.
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: /email/i })).toBeInTheDocument();
});

test("renders an empty-state message when there are no rows", () => {
  render(<CohortRosterTable rows={[]} />);
  expect(screen.getByText(/no members or invites yet/i)).toBeInTheDocument();
});

test("renders a Remove control only for accepted members that carry an earnerId", () => {
  render(
    <CohortRosterTable
      rows={[
        { email: "member@x.com", status: "active", accepted: true, earnerId: "earner-9" },
        { email: "pending@x.com", status: "invited", accepted: false },
      ]}
    />
  );
  // Only one Remove control — pending invites have no earnerId and are not members yet.
  expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(1);
});

test("does not render a Remove control for an accepted row missing an earnerId (defensive)", () => {
  render(
    <CohortRosterTable rows={[{ email: "member@x.com", status: "active", accepted: true }]} />
  );
  expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
});
