-- Enable RLS everywhere.
alter table earners enable row level security;
alter table credentials enable row level security;
alter table credential_skills enable row level security;
alter table earner_skills enable row level security;
alter table skills enable row level security;
alter table sponsors enable row level security;
alter table sponsor_admins enable row level security;
alter table cohort_members enable row level security;
alter table advisor_threads enable row level security;
alter table advisor_messages enable row level security;

-- Helper: is the current user an admin of this sponsor?
create or replace function is_sponsor_admin(target_sponsor uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from sponsor_admins
    where sponsor_id = target_sponsor and user_id = auth.uid()
  );
$$;

-- earners: self-access only.
create policy earners_self_select on earners
  for select using (id = auth.uid());
create policy earners_self_update on earners
  for update using (id = auth.uid());
create policy earners_self_insert on earners
  for insert with check (id = auth.uid());

-- credentials: owned by the earner.
create policy credentials_owner_all on credentials
  for all using (earner_id = auth.uid()) with check (earner_id = auth.uid());

-- credential_skills: visible if the parent credential is owned.
create policy credential_skills_owner_all on credential_skills
  for all using (
    exists (select 1 from credentials c
            where c.id = credential_id and c.earner_id = auth.uid())
  ) with check (
    exists (select 1 from credentials c
            where c.id = credential_id and c.earner_id = auth.uid())
  );

-- earner_skills: owned by the earner.
create policy earner_skills_owner_all on earner_skills
  for all using (earner_id = auth.uid()) with check (earner_id = auth.uid());

-- advisor threads/messages: owned by the earner.
create policy advisor_threads_owner_all on advisor_threads
  for all using (earner_id = auth.uid()) with check (earner_id = auth.uid());
create policy advisor_messages_owner_all on advisor_messages
  for all using (earner_id = auth.uid()) with check (earner_id = auth.uid());

-- skills: world-readable (public vocabulary), no client writes.
create policy skills_read_all on skills for select using (true);

-- sponsors: readable by their admins.
create policy sponsors_admin_select on sponsors
  for select using (is_sponsor_admin(id));

-- sponsor_admins: a user sees their own admin rows.
create policy sponsor_admins_self_select on sponsor_admins
  for select using (user_id = auth.uid());

-- cohort_members: the earner sees their own; the sponsor's admins see their cohort.
create policy cohort_members_earner_select on cohort_members
  for select using (earner_id = auth.uid());
create policy cohort_members_earner_update on cohort_members
  for update using (earner_id = auth.uid());     -- earner controls consent flags
create policy cohort_members_sponsor_select on cohort_members
  for select using (is_sponsor_admin(sponsor_id));

-- Sponsor admins may read consented earner skills.
create policy earner_skills_sponsor_select on earner_skills
  for select using (
    exists (
      select 1 from cohort_members m
      where m.earner_id = earner_skills.earner_id
        and m.consent_share_skills = true
        and is_sponsor_admin(m.sponsor_id)
    )
  );
