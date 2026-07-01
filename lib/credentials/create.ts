import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateCredentialResult,
  NewCredentialInput,
  ParsedCredential,
  VerificationStatus,
  VerifyInput,
} from "@/lib/credentials/types";
import type { LlmClient } from "@/lib/skills/types";
import { parseOpenBadge } from "@/lib/credentials/parse-ob";
import { extractBakedAssertion } from "@/lib/credentials/extract-baked-badge";
import { verifyCredential } from "@/lib/credentials/verify";
import { uploadCredentialFile } from "@/lib/credentials/storage";
import { processCredential } from "@/lib/skills/index";

export interface CreateDeps {
  verifyFetch?: typeof fetch;
}

/**
 * Derive the JSON payload for a file import: parse JSON directly, else extract a baked assertion.
 * `mime` is expected to be a canonical type (`application/json` | `image/png` | `image/svg+xml`);
 * the Server Action (`importByFile`) normalizes browser MIME quirks + extension fallback before
 * calling here, so an unrecognized `mime` correctly yields `null` (stored `unverified`).
 */
function rawJsonFromFile(
  buffer: Buffer,
  mime: string
): unknown | null {
  if (mime === "application/json") {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
  }
  if (mime === "image/png" || mime === "image/svg+xml") {
    return extractBakedAssertion(buffer, mime);
  }
  return null;
}

/**
 * The single function all three import Server Actions call. Creates the credentials row,
 * uploads any file, sets an honest verification_status, and runs Plan 2's skills engine.
 * Post-insert failures (verification, skills) never delete the row — an imported credential
 * always lands in the wallet, honestly (spec §5).
 */
export async function createCredentialAndProcess(
  db: SupabaseClient,
  llm: LlmClient,
  input: NewCredentialInput,
  deps?: CreateDeps
): Promise<CreateCredentialResult> {
  let rawJson: unknown | null = null;
  let parsed: ParsedCredential;
  let storagePath: string | null = null;
  // Typed `string` (not the narrower randomUUID() template-literal type) since it is
  // reassigned below from the DB's returned id, which is a plain string.
  let credentialId: string = randomUUID();

  if (input.source === "manual") {
    // Persist the user-entered description into raw_json so Plan 2's descriptionFrom(raw_json)
    // (which reads root.description) feeds it to the skills extractor. Without this, a manual
    // credential's description would be silently dropped and only its title would drive extraction.
    // Store null (not an empty object) when there is no description, keeping rows tidy.
    rawJson = input.manual.description
      ? { description: input.manual.description }
      : null;
    parsed = {
      title: input.manual.title,
      issuerName: input.manual.issuerName,
      issuedDate: input.manual.issuedDate,
      description: input.manual.description,
    };
  } else if (input.source === "ob_url") {
    rawJson = input.raw_json;
    parsed = parseOpenBadge(rawJson);
  } else {
    // ob_file: upload first so storage_path is known at insert time.
    rawJson = rawJsonFromFile(input.fileBuffer, input.fileMime);
    parsed = parseOpenBadge(rawJson);
    const uploaded = await uploadCredentialFile(
      db,
      input.earnerId,
      credentialId,
      input.fileBuffer,
      input.fileMime,
      input.fileName
    );
    storagePath = uploaded.storagePath;
  }

  const { data: inserted, error: insErr } = await db
    .from("credentials")
    .insert({
      id: credentialId,
      earner_id: input.earnerId,
      source: input.source,
      raw_json: rawJson,
      issuer_name: parsed.issuerName,
      title: parsed.title,
      issued_date: parsed.issuedDate,
      storage_path: storagePath,
      verification_status: "unverified",
    })
    .select("id")
    .single();
  if (insErr) {
    // The file was uploaded BEFORE the insert (so storage_path is known at insert time). If the
    // insert fails, best-effort delete the just-uploaded object so we don't leak an orphaned,
    // unreferenced Storage file (Storage objects are NOT FK-cascaded — nothing else reaps them).
    if (storagePath) {
      await db.storage
        .from("credential-files")
        .remove([storagePath])
        .catch(() => {
          /* best-effort cleanup; the original insert error is what we surface */
        });
    }
    throw insErr;
  }
  credentialId = inserted.id as string;

  // Verify + persist honest status (skills run regardless of the outcome).
  const verifyInput: VerifyInput = { source: input.source, raw_json: rawJson };
  const verification = await verifyCredential(verifyInput, {
    fetchImpl: deps?.verifyFetch,
  });
  const verificationStatus: VerificationStatus = verification.status;
  const { error: updErr } = await db
    .from("credentials")
    .update({ verification_status: verificationStatus })
    .eq("id", credentialId);
  if (updErr) throw updErr;

  // Skills enrichment — a failure here must never fail the import.
  try {
    await processCredential(db, llm, credentialId);
  } catch (e) {
    console.error(
      `processCredential failed for credential ${credentialId}: ${(e as Error).message}`
    );
  }

  return { credentialId, verificationStatus };
}
