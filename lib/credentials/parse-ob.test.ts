import { expect, test } from "vitest";
import { parseOpenBadge } from "./parse-ob";

test("OB2.x Assertion pulls name/description/date from nested badge + issuedOn", () => {
  const raw = {
    type: "Assertion",
    issuedOn: "2024-05-01T00:00:00Z",
    badge: {
      name: "Welding Level 1",
      description: "Basic MIG welding.",
      issuer: { name: "Acme Trade School" },
    },
  };
  expect(parseOpenBadge(raw)).toEqual({
    title: "Welding Level 1",
    issuerName: "Acme Trade School",
    issuedDate: "2024-05-01",
    description: "Basic MIG welding.",
  });
});

test("OB2.x BadgeClass reads top-level name/description/issuer, no date", () => {
  const raw = {
    type: "BadgeClass",
    name: "Data Literacy",
    description: "Reading charts and tables.",
    issuer: { name: "OpenU" },
  };
  expect(parseOpenBadge(raw)).toEqual({
    title: "Data Literacy",
    issuerName: "OpenU",
    issuedDate: null,
    description: "Reading charts and tables.",
  });
});

test("OB3.0/VC reads credentialSubject.achievement + issuer.name + issuanceDate", () => {
  const raw = {
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuanceDate: "2025-01-15T12:00:00Z",
    issuer: { id: "did:web:issuer.example", name: "Future State College" },
    credentialSubject: {
      achievement: {
        name: "Project Management",
        description: "Plan, schedule, deliver.",
      },
    },
  };
  expect(parseOpenBadge(raw)).toEqual({
    title: "Project Management",
    issuerName: "Future State College",
    issuedDate: "2025-01-15",
    description: "Plan, schedule, deliver.",
  });
});

test("VC validFrom is used when issuanceDate is absent; issuer may be a bare string", () => {
  const raw = {
    validFrom: "2026-03-09",
    issuer: "Standalone Issuer",
    credentialSubject: { achievement: { name: "Time Management" } },
  };
  const out = parseOpenBadge(raw);
  expect(out.issuedDate).toBe("2026-03-09");
  expect(out.issuerName).toBe("Standalone Issuer");
  expect(out.title).toBe("Time Management");
  expect(out.description).toBe("");
});

test("achievement may be an array — first entry drives title/description", () => {
  const raw = {
    credentialSubject: {
      achievement: [
        { name: "Customer Service", description: "Help customers." },
        { name: "Scheduling" },
      ],
    },
  };
  const out = parseOpenBadge(raw);
  expect(out.title).toBe("Customer Service");
  expect(out.description).toBe("Help customers.");
});

test("null / non-object / unrecognized input returns a safe empty shape (never throws)", () => {
  const empty = { title: "", issuerName: "", issuedDate: null, description: "" };
  expect(parseOpenBadge(null)).toEqual(empty);
  expect(parseOpenBadge("not json")).toEqual(empty);
  expect(parseOpenBadge({ foo: "bar" })).toEqual(empty);
});

test("OB3.0/VC falls back to root-level description when achievement has none", () => {
  const raw = {
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    description: "Summary lives at the root of this envelope.",
    issuer: { name: "Future State College" },
    credentialSubject: {
      achievement: {
        name: "Project Management",
      },
    },
  };
  const out = parseOpenBadge(raw);
  expect(out.title).toBe("Project Management");
  expect(out.description).toBe("Summary lives at the root of this envelope.");
});

test("an incidental empty badge object does not shadow a valid envelope", () => {
  const withTopLevelName = {
    badge: {},
    type: "BadgeClass",
    name: "Data Literacy",
    issuer: { name: "OpenU" },
  };
  expect(parseOpenBadge(withTopLevelName).title).toBe("Data Literacy");

  const withAchievement = {
    badge: { foo: 1 },
    credentialSubject: {
      achievement: { name: "Customer Service" },
    },
  };
  expect(parseOpenBadge(withAchievement).title).toBe("Customer Service");
});

test("OB2.x BadgeClass falls back to issuanceDate/validFrom when issuedOn is absent", () => {
  const withIssuanceDate = {
    type: "BadgeClass",
    name: "Data Literacy",
    issuer: { name: "OpenU" },
    issuanceDate: "2025-06-01T00:00:00Z",
  };
  expect(parseOpenBadge(withIssuanceDate).issuedDate).toBe("2025-06-01");

  const withValidFrom = {
    type: "BadgeClass",
    name: "Data Literacy",
    issuer: { name: "OpenU" },
    validFrom: "2025-07-04",
  };
  expect(parseOpenBadge(withValidFrom).issuedDate).toBe("2025-07-04");
});

test("an empty title is the guard predicate: unrecognized envelopes yield no title", () => {
  // importByUrl / importByFile use `!parseOpenBadge(raw).title` as the "don't persist a garbage
  // row" guard. Assert that a valid-JSON-but-unrelated object and an empty object both fail it,
  // while a real OB envelope passes it — locking the invariant the Server Actions depend on.
  expect(parseOpenBadge({}).title).toBe("");
  expect(parseOpenBadge({ status: "ok" }).title).toBe("");
  expect(parseOpenBadge({ type: "BadgeClass", name: "Real", issuer: { name: "I" } }).title).toBe(
    "Real"
  );
});
