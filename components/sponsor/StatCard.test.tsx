import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StatCard } from "./StatCard";

test("renders the label, the numeric value, and an optional hint", () => {
  const { rerender } = render(<StatCard label="Invited" value={12} />);
  // Label and value are both present and associated (label describes the value).
  expect(screen.getByText("Invited")).toBeInTheDocument();
  expect(screen.getByText("12")).toBeInTheDocument();
  // No hint rendered when the prop is omitted.
  expect(screen.queryByText(/of your cohort/i)).toBeNull();

  rerender(<StatCard label="Activated" value={5} hint="of your cohort" />);
  expect(screen.getByText("Activated")).toBeInTheDocument();
  expect(screen.getByText("5")).toBeInTheDocument();
  expect(screen.getByText("of your cohort")).toBeInTheDocument();
});

test("the value carries a text label, not color alone (has an accessible group name)", () => {
  render(<StatCard label="Imported" value={3} />);
  // The card is a labelled group so screen readers announce "Imported, 3".
  const group = screen.getByRole("group", { name: /imported/i });
  expect(group).toHaveTextContent("Imported");
  expect(group).toHaveTextContent("3");
});
