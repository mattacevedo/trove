import type { ParsedCredential } from "@/lib/credentials/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Accept an issuer that is either a { name } object or a bare string. */
function issuerName(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  return rec ? str(rec.name) : "";
}

/** Normalize an ISO datetime or date to yyyy-mm-dd; null when absent/unparseable. */
function isoDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Pure envelope parser across OB2.x (Assertion / BadgeClass) and OB3.0/VC shapes.
 * Returns a safe empty-ish ParsedCredential for anything unrecognized — never throws.
 */
export function parseOpenBadge(rawJson: unknown): ParsedCredential {
  const empty: ParsedCredential = {
    title: "",
    issuerName: "",
    issuedDate: null,
    description: "",
  };
  const root = asRecord(rawJson);
  if (!root) return empty;

  // OB2.x Assertion: name/description live under badge; date is issuedOn.
  const badge = asRecord(root.badge);
  if (badge) {
    return {
      title: str(badge.name),
      issuerName: issuerName(badge.issuer),
      issuedDate: isoDate(root.issuedOn),
      description: str(badge.description),
    };
  }

  // OB3.0 / VC: credentialSubject.achievement (object or array).
  const subject = asRecord(root.credentialSubject);
  if (subject) {
    const achievementRaw = subject.achievement;
    const achievement = Array.isArray(achievementRaw)
      ? asRecord(achievementRaw[0])
      : asRecord(achievementRaw);
    if (achievement) {
      return {
        title: str(achievement.name) || str(root.name),
        issuerName: issuerName(root.issuer),
        issuedDate: isoDate(root.issuanceDate) ?? isoDate(root.validFrom),
        description: str(achievement.description),
      };
    }
  }

  // OB2.x BadgeClass (or a flat VC with top-level name).
  if (str(root.name)) {
    return {
      title: str(root.name),
      issuerName: issuerName(root.issuer),
      issuedDate:
        isoDate(root.issuedOn) ??
        isoDate(root.issuanceDate) ??
        isoDate(root.validFrom),
      description: str(root.description),
    };
  }

  return empty;
}
