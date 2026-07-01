import { render, screen, within } from "@testing-library/react";
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

test("Tab from the last focusable element wraps focus to the first focusable element", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  await user.click(screen.getByRole("button", { name: /add credential/i }));

  // On the default (URL) tab, the last focusable element in the dialog is the form's submit
  // button; the first is the selected (URL) tab.
  const urlTab = screen.getByRole("tab", { name: /url/i });
  const dialog = screen.getByRole("dialog");
  const submitButton = within(dialog).getByRole("button", { name: /^add credential$/i });
  submitButton.focus();
  expect(document.activeElement).toBe(submitButton);

  await user.tab();
  expect(document.activeElement).toBe(urlTab);
});

test("Shift+Tab from the first focusable element wraps focus to the last focusable element", async () => {
  const user = userEvent.setup();
  render(<AddCredentialLauncher />);
  await user.click(screen.getByRole("button", { name: /add credential/i }));

  // Focus starts on the first (URL) tab per existing initial-focus behavior.
  const urlTab = screen.getByRole("tab", { name: /url/i });
  expect(document.activeElement).toBe(urlTab);
  const dialog = screen.getByRole("dialog");
  const submitButton = within(dialog).getByRole("button", { name: /^add credential$/i });

  await user.tab({ shift: true });
  expect(document.activeElement).toBe(submitButton);
});
