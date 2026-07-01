import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Button } from "./button";

test("button renders its label and meets the 44px touch-target floor", () => {
  render(<Button>Add credential</Button>);
  const btn = screen.getByRole("button", { name: "Add credential" });
  expect(btn).toBeInTheDocument();
  expect(btn.className).toContain("min-h-11");
  expect(btn.className).toContain("min-w-11");
});

test("button keeps a visible focus ring", () => {
  render(<Button>Save</Button>);
  expect(screen.getByRole("button").className).toContain("focus-visible:ring-2");
});
