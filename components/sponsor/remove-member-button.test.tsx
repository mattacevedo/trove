import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const removeMember = vi.fn();
vi.mock("@/app/sponsor/actions", () => ({ removeMember: (...a: unknown[]) => removeMember(...a) }));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test("renders a Remove control carrying the earner id in a hidden field", async () => {
  const { RemoveMemberButton } = await import("./remove-member-button");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<RemoveMemberButton earnerId="earner-9" email="member@x.com" />);
  const button = screen.getByRole("button", { name: /remove/i });
  expect(button).toBeInTheDocument();
  const hidden = button
    .closest("form")!
    .querySelector('input[name="earnerId"]') as HTMLInputElement;
  expect(hidden.value).toBe("earner-9");
});

test("asks for confirmation naming the member before submitting, and submits when confirmed", async () => {
  const { RemoveMemberButton } = await import("./remove-member-button");
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<RemoveMemberButton earnerId="earner-9" email="member@x.com" />);

  fireEvent.click(screen.getByRole("button", { name: /remove/i }));

  expect(confirmSpy).toHaveBeenCalledOnce();
  expect(confirmSpy.mock.calls[0][0]).toMatch(/member@x\.com/);
  await vi.waitFor(() => expect(removeMember).toHaveBeenCalledOnce());
});

test("does NOT call the removeMember action when the confirmation is declined", async () => {
  const { RemoveMemberButton } = await import("./remove-member-button");
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<RemoveMemberButton earnerId="earner-9" email="member@x.com" />);

  fireEvent.click(screen.getByRole("button", { name: /remove/i }));

  expect(removeMember).not.toHaveBeenCalled();
});
