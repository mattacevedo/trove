import { afterAll, expect, test, vi } from "vitest";
import { adminClient } from "./admin-client";
import { createCredentialAndProcess } from "@/lib/credentials/create";
import { getSkillVocabulary } from "@/lib/skills/data";
import type { LlmClient } from "@/lib/skills/types";

const admin = adminClient();
const created: string[] = [];
const uploadedPaths: string[] = [];

afterAll(async () => {
  // Storage objects are not FK-cascaded from any table — remove them explicitly, and
  // before deleting the earners/users so cleanup never leaves an orphaned Storage object.
  if (uploadedPaths.length > 0) {
    await admin.storage.from("credential-files").remove(uploadedPaths);
  }
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

async function seedEarner(): Promise<string> {
  const email = `imp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin
    .from("earners")
    .insert({ id: earnerId, handle: `imp${Date.now()}${Math.floor(Math.random() * 1000)}` });
  return earnerId;
}

test("manual import: creates an unverified row and rolls up earner_skills", async () => {
  const earnerId = await seedEarner();
  // Use a real seeded skill name so normalize produces an exact match via the fake LLM.
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill")!;
  const fakeLlm: LlmClient = {
    extractSkills: vi.fn(async () => [
      { rawName: target.canonical_name, type: "skill" as const, confidence: 0.7, source: "llm" as const },
    ]),
  };

  const { credentialId, verificationStatus } = await createCredentialAndProcess(
    admin,
    fakeLlm,
    {
      earnerId,
      source: "manual",
      manual: {
        title: "Paper Certificate",
        issuerName: "Night School",
        issuedDate: "2023-09-01",
        description: "Some description text.",
      },
    }
  );

  expect(verificationStatus).toBe("unverified");

  const { data: row } = await admin
    .from("credentials")
    .select("source, title, issuer_name, issued_date, verification_status")
    .eq("id", credentialId)
    .single();
  expect(row).toMatchObject({
    source: "manual",
    title: "Paper Certificate",
    issuer_name: "Night School",
    issued_date: "2023-09-01",
    verification_status: "unverified",
  });

  const { data: es } = await admin
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earnerId);
  expect(es).toHaveLength(1);
  expect(es![0].skill_id).toBe(target.id);
});

test("a thrown processCredential does NOT roll back / delete the credential row", async () => {
  const earnerId = await seedEarner();
  const throwingLlm: LlmClient = {
    extractSkills: vi.fn(async () => {
      throw new Error("simulated skills failure");
    }),
  };

  // Manual with a description forces the LLM path (no structured data), so the throw fires.
  const { credentialId } = await createCredentialAndProcess(admin, throwingLlm, {
    earnerId,
    source: "manual",
    manual: {
      title: "Resilient Cert",
      issuerName: "Issuer",
      issuedDate: null,
      description: "text that triggers llm extraction",
    },
  });

  const { data: row } = await admin
    .from("credentials")
    .select("id, verification_status")
    .eq("id", credentialId)
    .single();
  expect(row?.id).toBe(credentialId); // row survived the skills failure
  expect(row?.verification_status).toBe("unverified");
});

test("ob_url import: parses an OB2.x envelope, exercises the structured skills path, no verify block -> unverified", async () => {
  const earnerId = await seedEarner();
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill")!;

  // Inline OB2.x Assertion envelope. Includes an alignment to a REAL seeded O*NET skill
  // (targetName === the vocab's canonical_name) so extractStructured() finds a match and
  // the fake LLM is never invoked -- proving the structured path, not the LLM fallback.
  const envelope = {
    "@context": "https://w3id.org/openbadges/v2",
    type: "Assertion",
    id: "https://example.org/assertion.json",
    issuedOn: "2024-03-15T00:00:00Z",
    badge: {
      name: "Cloud Fundamentals",
      description: "Demonstrates foundational cloud computing knowledge.",
      issuer: { name: "Example Academy" },
      alignment: [
        {
          targetName: target.canonical_name,
          targetUrl: "https://example.org/skills/target",
          targetFramework: "O*NET",
        },
      ],
    },
  };

  const fakeLlm: LlmClient = {
    extractSkills: vi.fn(async () => {
      throw new Error("LLM must not be called when structured alignment data is present");
    }),
  };

  const { credentialId, verificationStatus } = await createCredentialAndProcess(
    admin,
    fakeLlm,
    {
      earnerId,
      source: "ob_url",
      raw_json: envelope,
      sourceUrl: "https://example.org/assertion.json",
    }
  );

  // No verify/verification block and no proof -> verifyCredential's honest fallback.
  expect(verificationStatus).toBe("unverified");
  expect(fakeLlm.extractSkills).not.toHaveBeenCalled();

  const { data: row } = await admin
    .from("credentials")
    .select("source, title, issuer_name, storage_path, verification_status")
    .eq("id", credentialId)
    .single();
  expect(row).toMatchObject({
    source: "ob_url",
    title: "Cloud Fundamentals",
    issuer_name: "Example Academy",
    storage_path: null,
    verification_status: "unverified",
  });

  const { data: es } = await admin
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earnerId);
  expect(es).toHaveLength(1);
  expect(es![0].skill_id).toBe(target.id);
});

test("ob_file import: uploads the JSON buffer to Storage before insert and stores a matching storage_path", async () => {
  const earnerId = await seedEarner();
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill")!;

  const envelope = {
    "@context": "https://w3id.org/openbadges/v2",
    type: "Assertion",
    id: "https://example.org/assertion-file.json",
    issuedOn: "2024-03-15T00:00:00Z",
    badge: {
      name: "Cloud Fundamentals",
      description: "Demonstrates foundational cloud computing knowledge.",
      issuer: { name: "Example Academy" },
      alignment: [
        {
          targetName: target.canonical_name,
          targetUrl: "https://example.org/skills/target",
          targetFramework: "O*NET",
        },
      ],
    },
  };
  const fileBuffer = Buffer.from(JSON.stringify(envelope));

  const fakeLlm: LlmClient = {
    extractSkills: vi.fn(async () => {
      throw new Error("LLM must not be called when structured alignment data is present");
    }),
  };

  const { credentialId, verificationStatus } = await createCredentialAndProcess(
    admin,
    fakeLlm,
    {
      earnerId,
      source: "ob_file",
      fileBuffer,
      fileMime: "application/json",
      fileName: "badge.json",
    }
  );

  const { data: row } = await admin
    .from("credentials")
    .select("source, title, issuer_name, storage_path, verification_status")
    .eq("id", credentialId)
    .single();
  expect(row?.source).toBe("ob_file");
  expect(row?.title).toBe("Cloud Fundamentals");
  expect(row?.issuer_name).toBe("Example Academy");
  expect(row?.verification_status).toBe("unverified");
  expect(row?.storage_path).toBeTruthy();
  expect(row!.storage_path as string).toMatch(new RegExp(`^${earnerId}/`));
  expect(verificationStatus).toBe("unverified");

  uploadedPaths.push(row!.storage_path as string);

  // Confirm the uploaded object actually exists and matches the original bytes.
  const { data: downloaded, error: dlErr } = await admin.storage
    .from("credential-files")
    .download(row!.storage_path as string);
  expect(dlErr).toBeNull();
  const downloadedText = await downloaded!.text();
  expect(downloadedText).toBe(fileBuffer.toString("utf8"));
});
