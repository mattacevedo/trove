import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const created: string[] = [];
const uploadedPaths: string[] = [];

afterAll(async () => {
  if (uploadedPaths.length > 0) {
    await admin.storage.from("credential-files").remove(uploadedPaths);
  }
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("earner B cannot read earner A's uploaded credential file", async () => {
  const a = await makeUserClient(`sa-${Date.now()}@example.com`);
  const b = await makeUserClient(`sb-${Date.now()}@example.com`);
  created.push(a.userId, b.userId);
  await a.client.from("earners").insert({ id: a.userId, handle: `sa${Date.now()}` });
  await b.client.from("earners").insert({ id: b.userId, handle: `sb${Date.now()}` });

  // A uploads under their own {userId}/... path via their RLS-scoped session client.
  const path = `${a.userId}/cred-1/badge.json`;
  const { error: upErr } = await a.client.storage
    .from("credential-files")
    .upload(path, Buffer.from('{"type":"Assertion"}'), {
      contentType: "application/json",
      upsert: true,
    });
  expect(upErr).toBeNull();
  uploadedPaths.push(path);

  // B tries to download A's object — Storage RLS must deny it.
  const { data: bData, error: bErr } = await b.client.storage
    .from("credential-files")
    .download(path);
  expect(bData).toBeNull();
  expect(bErr).not.toBeNull();

  // A can download their own object.
  const { data: aData, error: aErr } = await a.client.storage
    .from("credential-files")
    .download(path);
  expect(aErr).toBeNull();
  expect(aData).not.toBeNull();
});

test("earner B cannot upload into earner A's folder", async () => {
  const a = await makeUserClient(`sc-${Date.now()}@example.com`);
  const b = await makeUserClient(`sd-${Date.now()}@example.com`);
  created.push(a.userId, b.userId);
  // Insert earners rows for parity with real signed-up users (and the first test in this file),
  // so the fixture stays consistent and forward-compatible with any future earners-aware policy.
  await a.client.from("earners").insert({ id: a.userId, handle: `sc${Date.now()}` });
  await b.client.from("earners").insert({ id: b.userId, handle: `sd${Date.now()}` });

  const { error } = await b.client.storage
    .from("credential-files")
    .upload(`${a.userId}/cred-x/evil.json`, Buffer.from("{}"), {
      contentType: "application/json",
      upsert: true,
    });
  expect(error).not.toBeNull(); // insert policy checks foldername[1] = auth.uid()
});
