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

test("a visitor can actually get in: sign-in and wallet CTAs link to /login", () => {
  render(<Home />);
  const signIn = screen.getByRole("link", { name: /^sign in$/i });
  expect(signIn).toHaveAttribute("href", "/login");
  const cta = screen.getByRole("link", { name: /create your free wallet/i });
  expect(cta).toHaveAttribute("href", "/login");
  const sponsor = screen.getByRole("link", { name: /sponsor console/i });
  expect(sponsor).toHaveAttribute("href", "/login");
});

test("the three feature pillars and the honesty footer are present", () => {
  render(<Home />);
  expect(
    screen.getByRole("heading", { name: /^verified credentials$/i })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: /a real skills profile/i })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: /an advisor that knows you/i })
  ).toBeInTheDocument();
  expect(screen.getByText(/guidance, not a guarantee/i)).toBeInTheDocument();
});
