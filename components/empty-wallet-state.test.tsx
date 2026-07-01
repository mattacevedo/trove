import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { EmptyWalletState } from "./empty-wallet-state";

test("shows the empty message and an Add-credential CTA", () => {
  render(<EmptyWalletState />);
  expect(screen.getByText(/your wallet is empty/i)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /add (your first )?credential/i })
  ).toBeInTheDocument();
});
