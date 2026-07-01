import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmClient, StoredCredential } from "@/lib/skills/types";
import { extractSkills } from "@/lib/skills/extract";
import { normalizeSkills } from "@/lib/skills/normalize";
import {
  getSkillVocabulary,
  writeCredentialSkills,
  recomputeEarnerSkills,
} from "@/lib/skills/data";

/** Derive a description string from a credential's raw_json (OB description field), else "". */
function descriptionFrom(rawJson: unknown): string {
  if (typeof rawJson !== "object" || rawJson === null) return "";
  const root = rawJson as Record<string, unknown>;
  const direct = root.description;
  if (typeof direct === "string") return direct;
  const badge = root.badge as Record<string, unknown> | undefined;
  if (badge && typeof badge.description === "string") return badge.description;
  return "";
}

/**
 * The skills engine's single entry point. Runs when a credential is added/changed
 * (called by Plan 3's import flow). Pipeline: extract -> normalize -> write credential_skills
 * -> recompute earner_skills. Returns the earner's rolled-up skill count.
 */
export async function processCredential(
  db: SupabaseClient,
  llm: LlmClient,
  credentialId: string
): Promise<{ skillCount: number }> {
  const { data: cred, error } = await db
    .from("credentials")
    .select("id, earner_id, title, raw_json")
    .eq("id", credentialId)
    .single();
  if (error) throw error;

  const stored: StoredCredential = {
    id: cred.id as string,
    title: (cred.title as string) ?? "",
    description: descriptionFrom(cred.raw_json),
    raw_json: cred.raw_json ?? null,
  };

  const { mentions } = await extractSkills(stored, { llm });
  const vocabulary = await getSkillVocabulary(db);
  const matches = normalizeSkills(mentions, vocabulary);

  await writeCredentialSkills(db, credentialId, matches);
  return recomputeEarnerSkills(db, cred.earner_id as string);
}
