import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { StarterPrompts } from "./starter-prompts";

test("clicking a chip calls onPick with the chip's exact text", async () => {
  const onPick = vi.fn();
  render(<StarterPrompts onPick={onPick} />);
  await userEvent.click(screen.getByRole("button", { name: "What should I learn next?" }));
  expect(onPick).toHaveBeenCalledWith("What should I learn next?");
});
