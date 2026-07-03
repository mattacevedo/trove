import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
vi.mock("@/app/app/advisor/actions", () => ({ setTargetOccupation: vi.fn() }));
import { TargetOccupationSelect } from "./target-occupation-select";

test("renders a labeled select with None set + occupation options, preselecting the target", () => {
  render(
    <TargetOccupationSelect
      occupations={[
        { id: "o1", name: "Registered Nurse" },
        { id: "o2", name: "Software Developer" },
      ]}
      selectedId="o2"
    />
  );
  const select = screen.getByLabelText(/target occupation/i) as HTMLSelectElement;
  expect(select.value).toBe("o2");
  expect(screen.getByRole("option", { name: /none set/i })).toBeInTheDocument();
});
