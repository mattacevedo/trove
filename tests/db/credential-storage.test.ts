import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { getSignedFileUrl, uploadCredentialFile } from "@/lib/credentials/storage";

const admin = adminClient();
const uploadedPaths: string[] = [];

afterAll(async () => {
  // Storage objects are not FK-cascaded from any table — remove them explicitly.
  if (uploadedPaths.length > 0) {
    await admin.storage.from("credential-files").remove(uploadedPaths);
  }
});

test(
  "uploadCredentialFile + getSignedFileUrl round-trip via service-role client",
  async () => {
    const earnerId = "00000000-0000-0000-0000-000000000001";
    const credentialId = `test-cred-${Date.now()}`;
    const fileBuffer = Buffer.from("hello credential file", "utf8");

    const { storagePath } = await uploadCredentialFile(
      admin,
      earnerId,
      credentialId,
      fileBuffer,
      "text/plain",
      "badge.txt"
    );
    uploadedPaths.push(storagePath);

    expect(storagePath).toBe(`${earnerId}/${credentialId}/badge.txt`);

    const signedUrl = await getSignedFileUrl(admin, storagePath);
    expect(signedUrl).toContain("credential-files");

    const res = await fetch(signedUrl);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello credential file");
  },
  10000
);
