import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { CoverageBars } from "./CoverageBars";

const rows = [
  { skillName: "Python", memberCount: 8 },
  { skillName: "SQL", memberCount: 2 },
];

test("renders an accessible data table with a caption and every skill row", () => {
  render(<CoverageBars rows={rows} />);
  const table = screen.getByRole("table", { name: /skill coverage/i });
  expect(table).toBeInTheDocument();
  // Header cells present.
  expect(within(table).getByRole("columnheader", { name: /skill/i })).toBeInTheDocument();
  expect(within(table).getByRole("columnheader", { name: /members/i })).toBeInTheDocument();
  // Each skill + its count appears in the table.
  expect(within(table).getByRole("cell", { name: "Python" })).toBeInTheDocument();
  expect(within(table).getByRole("cell", { name: "8" })).toBeInTheDocument();
  expect(within(table).getByRole("cell", { name: "SQL" })).toBeInTheDocument();
  expect(within(table).getByRole("cell", { name: "2" })).toBeInTheDocument();
});

test("bars are decorative (aria-hidden) so the count is read once, from the table", () => {
  const { container } = render(<CoverageBars rows={rows} />);
  const bars = container.querySelector('[data-testid="coverage-bars"]');
  expect(bars).not.toBeNull();
  expect(bars).toHaveAttribute("aria-hidden", "true");
});

test("bar width is proportional to the max count", () => {
  const { container } = render(<CoverageBars rows={rows} />);
  const fills = container.querySelectorAll('[data-testid="bar-fill"]');
  expect(fills).toHaveLength(2);
  // Python is the max (8) -> 100%; SQL is 2/8 -> 25%.
  expect((fills[0] as HTMLElement).style.width).toBe("100%");
  expect((fills[1] as HTMLElement).style.width).toBe("25%");
});

test("empty state communicates no consented skills in words", () => {
  render(<CoverageBars rows={[]} />);
  expect(screen.getByText(/no consented skill data yet/i)).toBeInTheDocument();
});
