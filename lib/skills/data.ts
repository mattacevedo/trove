import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CanonicalSkill,
  NormalizedSkillMatch,
} from "@/lib/skills/types";
import { rollUpEarnerSkills } from "@/lib/skills/rollup";

/** Load the seeded canonical vocabulary. Aliases come from the static table, not the DB. */
export async function getSkillVocabulary(
  db: SupabaseClient
): Promise<CanonicalSkill[]> {
  // .range makes the row bound explicit (PostgREST defaults to 1000). v1 vocabulary is well
  // under this; TODO: switch to keyset pagination before growing the vocabulary past ~10k rows.
  const { data, error } = await db
    .from("skills")
    .select("id, canonical_name, type, onet_id")
    .range(0, 9999);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    canonical_name: row.canonical_name as string,
    type: row.type as CanonicalSkill["type"],
    onet_id: (row.onet_id as string | null) ?? null,
    aliases: [],
  }));
}

/** Replace this credential's credential_skills with the matched (non-null) skills. */
export async function writeCredentialSkills(
  db: SupabaseClient,
  credentialId: string,
  matches: NormalizedSkillMatch[]
): Promise<void> {
  const { error: delErr } = await db
    .from("credential_skills")
    .delete()
    .eq("credential_id", credentialId);
  if (delErr) throw delErr;

  // Collapse to one row per skill (highest confidence wins) and drop unmatched.
  const bySkill = new Map<string, number>();
  for (const m of matches) {
    if (m.skillId === null) continue;
    bySkill.set(m.skillId, Math.max(bySkill.get(m.skillId) ?? 0, m.confidence));
  }
  if (bySkill.size === 0) return;

  const rows = Array.from(bySkill.entries()).map(([skill_id, confidence]) => ({
    credential_id: credentialId,
    skill_id: skill_id,
    confidence,
  }));
  const { error: insErr } = await db.from("credential_skills").insert(rows);
  if (insErr) throw insErr;
}

/**
 * Re-derive earner_skills from all of the earner's credential_skills. Idempotent
 * delete-then-insert; must be called after any mutation of credential_skills for the earner.
 */
export async function recomputeEarnerSkills(
  db: SupabaseClient,
  earnerId: string
): Promise<{ skillCount: number }> {
  // Select credential_id so we can group rows by credential (required for correct
  // source_count math — rollUpEarnerSkills dedupes within a credential and counts
  // one source per contributing credential). The !inner join filters to this earner.
  const { data: rows, error: readErr } = await db
    .from("credential_skills")
    .select("credential_id, skill_id, confidence, credentials!inner(earner_id)")
    .eq("credentials.earner_id", earnerId);
  if (readErr) throw readErr;

  // Build one match-list per credential to feed rollUpEarnerSkills faithfully.
  const byCredential = new Map<string, NormalizedSkillMatch[]>();
  for (const row of rows ?? []) {
    const credId = row.credential_id as string;
    const list = byCredential.get(credId) ?? [];
    list.push({
      candidate: "",
      skillId: row.skill_id as string,
      confidence: row.confidence as number,
      method: "exact",
    });
    byCredential.set(credId, list);
  }

  const rollups = rollUpEarnerSkills(Array.from(byCredential.values()));

  const { error: delErr } = await db
    .from("earner_skills")
    .delete()
    .eq("earner_id", earnerId);
  if (delErr) throw delErr;

  if (rollups.length === 0) return { skillCount: 0 };

  const upsertRows = rollups.map((r) => ({
    earner_id: earnerId,
    skill_id: r.skillId,
    source_count: r.sourceCount,
    highest_confidence: r.highestConfidence,
  }));
  const { error: insErr } = await db.from("earner_skills").insert(upsertRows);
  if (insErr) throw insErr;

  return { skillCount: upsertRows.length };
}
