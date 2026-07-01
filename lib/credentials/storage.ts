import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "credential-files";

/** Strip path separators / control chars from a user-supplied file name. */
function sanitizeFileName(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim();
  return base.length > 0 ? base : "file";
}

/**
 * Upload a credential's source file to the private bucket under {earnerId}/{credentialId}/.
 * Returns the storage path to persist in credentials.storage_path.
 */
export async function uploadCredentialFile(
  db: SupabaseClient,
  earnerId: string,
  credentialId: string,
  fileBuffer: Buffer,
  fileMime: string,
  fileName: string
): Promise<{ storagePath: string }> {
  const storagePath = `${earnerId}/${credentialId}/${sanitizeFileName(fileName)}`;
  const { error } = await db.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, { contentType: fileMime, upsert: true });
  if (error) throw error;
  return { storagePath };
}

/** Signed URL for private display in the wallet (default 1h). */
export async function getSignedFileUrl(
  db: SupabaseClient,
  storagePath: string,
  expiresInSeconds = 3600
): Promise<string> {
  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}
