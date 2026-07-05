import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { MemberTable } from "./MemberTable";

const rows = [
  {
    handle: "ada",
    status: "active",
    consentSkills: true,
    consentCredentials: false,
    joinedAt: "2026-03-01T00:00:00.000Z",
  },
  {
    handle: null,
    status: "invited",
    consentSkills: false,
    consentCredentials: false,
    joinedAt: "2026-06-15T00:00:00.000Z",
  },
];

test("renders a real table with scoped column headers", () => {
  render(<MemberTable rows={rows} />);
  const table = screen.getByRole("table", { name: /cohort members/i });
  const headers = within(table).getAllByRole("columnheader");
  const headerText = headers.map((h) => h.textContent);
  expect(headerText).toEqual(
    expect.arrayContaining(["Member", "Status", "Skills shared", "Credentials shared", "Joined"])
  );
  // Every column header is a proper <th scope="col">.
  headers.forEach((h) => expect(h).toHaveAttribute("scope", "col"));
});

test("shows the handle, a fallback for null handles, and consent as text (not color-only)", () => {
  render(<MemberTable rows={rows} />);
  expect(screen.getByText("@ada")).toBeInTheDocument();
  // Null handle falls back to a readable placeholder, never blank.
  expect(screen.getByText(/pending/i)).toBeInTheDocument();
  // Consent booleans render as words, so meaning does not depend on a colored dot.
  expect(screen.getAllByText("Yes").length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText("No").length).toBeGreaterThanOrEqual(2);
});

test("does not expose credential or skill detail — only the consent flags", () => {
  render(<MemberTable rows={rows} />);
  // The table has exactly the five allowed columns and no extra ones.
  const table = screen.getByRole("table", { name: /cohort members/i });
  expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
});

test("renders an empty state when there are no members", () => {
  render(<MemberTable rows={[]} />);
  expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});
