-- Private bucket for uploaded credential files (raw OB JSON, baked PNG/SVG).
-- Applied via the Management API: node scripts/apply-migration.mjs supabase/migrations/0004_credential_storage.sql
insert into storage.buckets (id, name, public)
values ('credential-files', 'credential-files', false)
on conflict (id) do nothing;

-- Path convention: {earner_id}/{credential_id}/{filename}. An earner may read/write/delete
-- only objects under their own uuid-prefixed folder — mirrors credentials_owner_all
-- (0003_rls_policies.sql). Service-role bypasses RLS for server-side test seeding.
create policy credential_files_owner_select on storage.objects
  for select using (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy credential_files_owner_insert on storage.objects
  for insert with check (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- upsert:true in uploadCredentialFile takes the UPDATE path when an object already exists at the
-- path (e.g. a retried Server Action re-running createCredentialAndProcess for the same credentialId,
-- or a future replace-file flow). Without an UPDATE policy those writes would be RLS-denied. Scoped
-- identically to insert/select so an earner may only overwrite objects in their own folder.
create policy credential_files_owner_update on storage.objects
  for update using (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy credential_files_owner_delete on storage.objects
  for delete using (
    bucket_id = 'credential-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
