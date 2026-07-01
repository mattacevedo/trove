"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { createAnthropicLlmClient } from "@/lib/skills/llm";
import { createCredentialAndProcess } from "@/lib/credentials/create";
import { verifyCredential } from "@/lib/credentials/verify";
import { parseOpenBadge } from "@/lib/credentials/parse-ob";

const IMPORT = "/app/wallet/import";
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

// Accepted content types keyed by canonical MIME. Browsers/OSes are inconsistent about the MIME
// they attach to uploads (SVG often arrives as text/xml or empty; JSON as text/plain or empty),
// so we ALSO accept by file extension and normalize to a canonical MIME the parser understands.
const MIME_BY_EXT: Record<string, string> = {
  json: "application/json",
  png: "image/png",
  svg: "image/svg+xml",
};
const KNOWN_MIME = new Set(Object.values(MIME_BY_EXT));

/**
 * Resolve an upload to a canonical MIME the pipeline understands, tolerating browser MIME quirks:
 * trust a known `upload.type`, else fall back to the file extension. Returns null when neither
 * yields a supported type (→ bad_type).
 */
function resolveUploadMime(type: string, name: string): string | null {
  if (KNOWN_MIME.has(type)) return type;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? null;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function requireUserId(): Promise<string> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user.id;
}

export async function importByUrl(formData: FormData): Promise<void> {
  const url = String(formData.get("url") ?? "").trim();
  if (!url || !isHttpUrl(url)) redirect(`${IMPORT}?error=invalid_url`);

  const userId = await requireUserId();

  // Keep redirect() OUT of the try/catch blocks: redirect() signals via a thrown NEXT_REDIRECT
  // control-flow error, which a bare catch would swallow. We set outcome locals inside try and
  // branch/redirect once afterward. The fetch and the JSON parse get SEPARATE try/catch blocks so
  // a reachable-but-non-JSON body (HTTP 200 returning HTML/truncated text) reports invalid_json,
  // not the misleading fetch_failed. (spec §5: an unfetchable/unparseable ob_url never becomes a row.)
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    redirect(`${IMPORT}?error=fetch_failed`);
  }
  if (!res.ok) redirect(`${IMPORT}?error=fetch_failed`);

  let raw_json: unknown;
  try {
    raw_json = await res.json();
  } catch {
    redirect(`${IMPORT}?error=invalid_json`);
  }
  if (raw_json === null || typeof raw_json !== "object") {
    redirect(`${IMPORT}?error=invalid_json`);
  }

  // Guard the envelope BEFORE inserting: parseOpenBadge never throws and returns an empty-title
  // shape for unrecognized JSON (e.g. {} or an unrelated API's {"status":"ok"}). Persisting that
  // would leave the earner with a blank, unexplained card and violate the "no garbage row" invariant.
  if (!parseOpenBadge(raw_json).title) {
    redirect(`${IMPORT}?error=unrecognized_credential`);
  }

  const supabase = await createServerClient();
  await createCredentialAndProcess(supabase, createAnthropicLlmClient(), {
    earnerId: userId,
    source: "ob_url",
    raw_json,
    sourceUrl: url,
  });
  revalidatePath("/app");
  redirect("/app");
}

export async function importByFile(formData: FormData): Promise<void> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect(`${IMPORT}?error=no_file`);
  const upload = file as File;
  const fileMime = resolveUploadMime(upload.type, upload.name);
  if (!fileMime) redirect(`${IMPORT}?error=bad_type`);
  if (upload.size > MAX_FILE_BYTES) redirect(`${IMPORT}?error=too_large`);

  const userId = await requireUserId();
  const fileBuffer = Buffer.from(await upload.arrayBuffer());

  // For a JSON upload we can validate the envelope up front (an unrecognized JSON file should not
  // become a blank row). Baked PNG/SVG are best-effort: they legitimately store `unverified` with
  // raw_json:null when nothing is embedded (spec §5), so we do NOT block those here — the image is
  // still worth keeping in the wallet even if we could not extract an assertion.
  if (fileMime === "application/json") {
    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(fileBuffer.toString("utf8"));
    } catch {
      redirect(`${IMPORT}?error=invalid_json`);
    }
    if (!parseOpenBadge(parsedJson).title) {
      redirect(`${IMPORT}?error=unrecognized_credential`);
    }
  }

  const supabase = await createServerClient();
  await createCredentialAndProcess(supabase, createAnthropicLlmClient(), {
    earnerId: userId,
    source: "ob_file",
    fileBuffer,
    fileMime, // canonical MIME, so the pipeline's parser/branching is deterministic
    fileName: upload.name,
  });
  revalidatePath("/app");
  redirect("/app");
}

export async function importManual(formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) redirect(`${IMPORT}?error=missing_title`);

  const userId = await requireUserId();
  const supabase = await createServerClient();
  await createCredentialAndProcess(supabase, createAnthropicLlmClient(), {
    earnerId: userId,
    source: "manual",
    manual: {
      title,
      issuerName: String(formData.get("issuer_name") ?? "").trim(),
      issuedDate: String(formData.get("issued_date") ?? "").trim() || null,
      description: String(formData.get("description") ?? "").trim(),
    },
  });
  revalidatePath("/app");
  redirect("/app");
}

/**
 * On-demand re-verify (spec §5's verify affordance). Reloads raw_json, re-runs the identical
 * verifyCredential, and persists the new status. RLS ensures the earner owns the row.
 */
export async function reverifyCredential(formData: FormData): Promise<void> {
  const credentialId = String(formData.get("credential_id") ?? "").trim();
  if (!credentialId) redirect("/app");

  await requireUserId();
  const supabase = await createServerClient();
  const { data: cred } = await supabase
    .from("credentials")
    .select("id, source, raw_json")
    .eq("id", credentialId)
    .single();
  if (cred) {
    const result = await verifyCredential({
      source: cred.source as "ob_url" | "ob_file" | "manual",
      raw_json: cred.raw_json ?? null,
    });
    await supabase
      .from("credentials")
      .update({ verification_status: result.status })
      .eq("id", credentialId);
  }
  revalidatePath("/app");
  redirect("/app");
}
