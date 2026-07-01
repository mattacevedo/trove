import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AddCredentialLauncher } from "./add-credential-launcher";

test("clicking the launcher opens the dialog and moves focus to the first tab", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  const trigger = screen.getByRole("button", { name: /add credential/i });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeInTheDocument();
  // Focus must land on a meaningful control — the first (URL) tab — not the bare close "✕".
  const urlTab = screen.getByRole("tab", { name: /url/i });
  expect(document.activeElement).toBe(urlTab);
});

test("Escape closes the dialog and returns focus to the launcher", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  const trigger = screen.getByRole("button", { name: /add credential/i });
  await user.click(trigger);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(trigger);
});

test("the dialog exposes URL, File, and Manual tabs", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  await user.click(screen.getByRole("button", { name: /add credential/i }));
  expect(screen.getByRole("tab", { name: /url/i })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /file/i })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /manual/i })).toBeInTheDocument();
});
