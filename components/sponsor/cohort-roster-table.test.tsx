import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CohortRosterTable } from "./cohort-roster-table";

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
  expect(screen.getByText(/pending/i)).toBeInTheDocument();
  // The table has a caption or column header for accessibility.
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: /email/i })).toBeInTheDocument();
});

test("renders an empty-state message when there are no rows", () => {
  render(<CohortRosterTable rows={[]} />);
  expect(screen.getByText(/no members or invites yet/i)).toBeInTheDocument();
});
