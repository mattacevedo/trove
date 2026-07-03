import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { OccupationCard } from "./occupation-card";
import type { OccupationGap } from "@/lib/advisor/types";

const gap: OccupationGap = {
  occupationId: "A",
  occupationName: "Registered Nurse",
  haveSkillIds: ["s1"],
  missingSkillNames: ["Critical Thinking"],
  haveCount: 1,
  totalCount: 3,
  coveragePct: 33,
};

test("renders X of Y, missing chips, and the unverified flag only when set", () => {
  const { rerender } = render(<OccupationCard gap={gap} />);
  expect(screen.getByText(/1/)).toBeInTheDocument();
  expect(screen.getByText("Critical Thinking")).toBeInTheDocument();
  expect(screen.queryByText(/unverified credential/i)).toBeNull();

  rerender(<OccupationCard gap={gap} reliesOnUnverified />);
  expect(screen.getByText(/unverified credential/i)).toBeInTheDocument();
});
