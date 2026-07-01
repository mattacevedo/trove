import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Home from "./page";

test("landing page shows the Trove wordmark and value prop", () => {
  render(<Home />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Trove" })
  ).toBeInTheDocument();
  expect(screen.getByText(/AI advisor/i)).toBeInTheDocument();
});
