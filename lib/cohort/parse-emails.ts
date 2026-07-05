// Parses a free-text roster (comma / newline / whitespace separated) into deduped, lowercased,
// validated emails. Pure + SDK-free so it is unit-testable and reusable by the invite action.
//
// Tokenizing strategy: split into top-level entries on commas/newlines first (how a pasted roster
// is naturally delimited — one address per line or per comma). Within an entry that itself contains
// further whitespace (e.g. "c@x.com d@x.com" or "also bad@"), each whitespace-separated piece is
// resolved independently: valid emails are extracted regardless of how many share the entry, and
// among the remaining pieces only ones that are email-SHAPED (contain "@") are reported invalid —
// bare prose words (e.g. "also") picked up from a free-typed line are noise, not a failed address,
// and are dropped silently. A whitespace-free entry that fails validation (e.g. "not-an-email") is
// always reported invalid in full, since the user offered it as a single, deliberate entry.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const entries = raw
    .split(/[\n,]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const pieces = entry.split(/\s+/).filter((p) => p.length > 0);
    const soleEntry = pieces.length === 1;

    for (const piece of pieces) {
      const lower = piece.toLowerCase();
      if (EMAIL_RE.test(lower)) {
        if (!seen.has(lower)) {
          seen.add(lower);
          valid.push(lower);
        }
      } else if (soleEntry || piece.includes("@")) {
        invalid.push(piece);
      }
    }
  }

  return { valid, invalid };
}
