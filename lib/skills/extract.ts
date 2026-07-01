import type {
  ExtractResult,
  LlmClient,
  RawSkillMention,
  SkillType,
  StoredCredential,
} from "@/lib/skills/types";

export interface ExtractDeps {
  llm: LlmClient;
}

const LLM_CONFIDENCE_CAP = 0.7;

interface AlignmentObject {
  targetName?: unknown;
  targetUrl?: unknown;
  targetFramework?: unknown;
  targetType?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function typeFromTargetType(targetType: unknown): SkillType {
  return targetType === "CFItem" || targetType === "CFRubric"
    ? "competency"
    : "skill";
}

function alignmentToMention(a: AlignmentObject): RawSkillMention | null {
  if (typeof a.targetName !== "string" || a.targetName.length === 0) return null;
  const mention: RawSkillMention = {
    rawName: a.targetName,
    type: typeFromTargetType(a.targetType),
    confidence: 1.0,
    source: "structured",
  };
  if (typeof a.targetUrl === "string") mention.externalId = a.targetUrl;
  if (typeof a.targetFramework === "string") mention.framework = a.targetFramework;
  return mention;
}

function mentionsFromAlignmentArray(value: unknown): RawSkillMention[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((a) => alignmentToMention(asRecord(a) ?? {}))
    .filter((m): m is RawSkillMention => m !== null);
}

/** Pure, synchronous structured parse across OB2.x, OB3.0/CLR, and generic VC shapes. */
export function extractStructured(rawJson: unknown): RawSkillMention[] {
  const root = asRecord(rawJson);
  if (!root) return [];

  // OB 2.x: BadgeClass.alignment[] or Assertion.badge.alignment[]
  const ob2Alignment =
    root.alignment ?? asRecord(root.badge)?.alignment ?? null;
  const ob2 = mentionsFromAlignmentArray(ob2Alignment);
  if (ob2.length > 0) return ob2;

  // OB 3.0 / CLR 2.0: credentialSubject.achievement(.alignment[]), achievement may be array.
  const subject = asRecord(root.credentialSubject);
  if (subject) {
    const achievement = subject.achievement;
    const achievements = Array.isArray(achievement)
      ? achievement
      : achievement != null
        ? [achievement]
        : [];
    const fromAchievements = achievements.flatMap((entry) =>
      mentionsFromAlignmentArray(asRecord(entry)?.alignment)
    );
    if (fromAchievements.length > 0) return fromAchievements;

    // Generic VC last-resort: credentialSubject.skills / .competencies string arrays.
    const generic: RawSkillMention[] = [];
    for (const key of ["skills", "competencies"] as const) {
      const arr = subject[key];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === "string" && item.length > 0) {
            generic.push({
              rawName: item,
              type: key === "competencies" ? "competency" : "skill",
              confidence: 0.9,
              source: "structured",
            });
          }
        }
      }
    }
    if (generic.length > 0) return generic;
  }

  return [];
}

/**
 * Structured-first extractor. Falls back to the injected LLM only when there is no
 * structured data AND the credential carries usable title/description text. The LLM is
 * called at most once per credential; its confidences are clamped to the cost/quality cap.
 */
export async function extractSkills(
  credential: StoredCredential,
  deps: ExtractDeps
): Promise<ExtractResult> {
  const structured = extractStructured(credential.raw_json);
  if (structured.length > 0) {
    return { mentions: structured, method: "structured" };
  }

  const hasText =
    credential.title.trim().length > 0 || credential.description.trim().length > 0;
  if (!hasText) return { mentions: [], method: "none" };

  const raw = await deps.llm.extractSkills({
    title: credential.title,
    description: credential.description,
  });
  const mentions = raw.map((m) => ({
    ...m,
    source: "llm" as const,
    confidence: Math.min(m.confidence, LLM_CONFIDENCE_CAP),
  }));
  return { mentions, method: "llm" };
}
