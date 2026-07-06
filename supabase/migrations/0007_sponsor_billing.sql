-- Plan 6 (Sponsor Console + Stripe billing) schema.
-- Adds billing columns to sponsors, an email-keyed cohort_invites table (invitees
-- have no earners row until they sign up, so invites cannot key off earner_id),
-- creation/accept/aggregate RPCs, and RLS/consent hardening for cohort_members +
-- sponsor reads of consented credentials.

-- 1) Billing columns on sponsors (name, plan, seats, stripe_customer_id exist in 0002).
alter table sponsors
  add column stripe_subscription_id text,
  add column subscription_status text not null default 'inactive';

-- 1b) One sponsor per Stripe customer. The webhook (Task 12) resolves the sponsor row by
--     stripe_customer_id and MUST get a single row; a partial unique index enforces that while
--     still allowing many rows with a null customer id (sponsors that never checked out).
create unique index sponsors_stripe_customer_id_key
  on sponsors (stripe_customer_id)
  where stripe_customer_id is not null;

-- 2) Email-keyed invites. Unique per (sponsor, email) so re-inviting is a no-op skip.
create table cohort_invites (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references sponsors (id) on delete cascade,
  email citext not null,
  token text not null unique,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (sponsor_id, email)
);
create index cohort_invites_sponsor_idx on cohort_invites (sponsor_id);

alter table cohort_invites enable row level security;

-- 2b) Webhook idempotency ledger. handleStripeEvent (Task 12) inserts event.id FIRST and treats a
--     unique-violation (23505) as an already-processed duplicate, returning without re-applying side
--     effects. RLS is enabled with NO client policy — only the service-role webhook writes it.
create table stripe_events (
  id text primary key,
  received_at timestamptz not null default now()
);
alter table stripe_events enable row level security;

-- 3) create_sponsor: atomic sponsor + admin insert. Only creation path for sponsors.
create or replace function create_sponsor(sponsor_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into sponsors (name) values (sponsor_name) returning id into new_id;
  insert into sponsor_admins (sponsor_id, user_id) values (new_id, auth.uid());
  return new_id;
end;
$$;

-- 4) accept_cohort_invite: link the calling earner to the invite's sponsor.
--    SECURITY: the invite is bound to the EMAIL it was issued to. We resolve the caller's own email
--    from auth.users inside the definer body and require the invite's email to match, so a user who
--    merely learns/guesses a token cannot join a cohort they were not invited to.
create or replace function accept_cohort_invite(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_sponsor uuid;
  v_caller_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from earners where id = auth.uid()) then
    raise exception 'no earner row for caller';
  end if;

  select email into v_caller_email from auth.users where id = auth.uid();
  if v_caller_email is null then
    raise exception 'no email for caller';
  end if;

  -- Match on token AND the caller's own email (citext-insensitive via the column type).
  select sponsor_id into target_sponsor
  from cohort_invites
  where token = invite_token
    and accepted_at is null
    and email = v_caller_email;

  if target_sponsor is null then
    raise exception 'invite not found, already accepted, or not addressed to this account';
  end if;

  insert into cohort_members (sponsor_id, earner_id, status)
  values (target_sponsor, auth.uid(), 'active')
  on conflict (sponsor_id, earner_id)
  do update set status = 'active';

  update cohort_invites
  set accepted_at = now()
  where token = invite_token
    and accepted_at is null
    and email = v_caller_email;

  return target_sponsor;
end;
$$;

-- 5) sponsor_engagement: privacy-preserving funnel counts for one sponsor.
create or replace function sponsor_engagement(target_sponsor uuid)
returns table (invited int, activated int, imported int, advisor_used int)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_sponsor_admin(target_sponsor) then
    raise exception 'not a sponsor admin';
  end if;

  return query
  select
    (
      (select count(*) from cohort_invites ci
         where ci.sponsor_id = target_sponsor and ci.accepted_at is null)
      + (select count(*) from cohort_members cm
           where cm.sponsor_id = target_sponsor)
    )::int as invited,
    (select count(*) from cohort_members cm
       where cm.sponsor_id = target_sponsor and cm.status = 'active')::int as activated,
    (select count(*) from cohort_members cm
       where cm.sponsor_id = target_sponsor and cm.status = 'active'
         and exists (select 1 from credentials c where c.earner_id = cm.earner_id))::int as imported,
    (select count(*) from cohort_members cm
       where cm.sponsor_id = target_sponsor and cm.status = 'active'
         and exists (select 1 from advisor_messages am where am.earner_id = cm.earner_id))::int as advisor_used;
end;
$$;

-- 6) sponsor_skill_coverage: top consented skills across active members.
create or replace function sponsor_skill_coverage(target_sponsor uuid)
returns table (skill_name text, member_count int)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_sponsor_admin(target_sponsor) then
    raise exception 'not a sponsor admin';
  end if;

  return query
  select s.canonical_name as skill_name, count(distinct es.earner_id)::int as member_count
  from cohort_members cm
  join earner_skills es on es.earner_id = cm.earner_id
  join skills s on s.id = es.skill_id
  where cm.sponsor_id = target_sponsor
    and cm.status = 'active'
    and cm.consent_share_skills = true
  group by s.canonical_name
  order by member_count desc
  limit 20;
end;
$$;

-- 7) RLS: sponsor admins fully manage their own invites.
create policy cohort_invites_sponsor_all on cohort_invites
  for all using (is_sponsor_admin(sponsor_id))
  with check (is_sponsor_admin(sponsor_id));

-- 8) RLS: sponsor admins may read a member's credentials ONLY with consent.
--    Mirrors earner_skills_sponsor_select (0003); closes the inert-flag gap where
--    consent_share_credentials had no reader policy.
create policy credentials_sponsor_select on credentials
  for select using (
    exists (
      select 1 from cohort_members m
      where m.earner_id = credentials.earner_id
        and m.consent_share_credentials = true
        and is_sponsor_admin(m.sponsor_id)
    )
  );

-- 9) RLS: a sponsor admin may UPDATE their own sponsor row. This is required for the
--    client-side billing write in ensureStripeCustomer (Task 10), which persists
--    stripe_customer_id under the admin's RLS-scoped client during Checkout/Portal.
--    The Stripe WEBHOOK (Task 12) writes subscription_status/plan/seats/stripe_subscription_id
--    via the SERVICE-ROLE key (bypasses RLS), so it does not rely on this policy.
create policy sponsors_admin_update on sponsors
  for update using (is_sponsor_admin(id))
  with check (is_sponsor_admin(id));

-- 9b) RLS: a cohort's own sponsor admin may read that member's earners row. The handle is already
--     public (rendered on /u/[handle]); this policy lets the console show which invitees have
--     actually signed up, and fixes the null-handle bug where the cohort list could not resolve a
--     member's handle through the admin's RLS-scoped client. Scoped strictly to the admin's own
--     cohorts via is_sponsor_admin, so it never leaks earners outside the sponsor's membership.
create policy earners_sponsor_select on earners
  for select using (
    exists (
      select 1 from cohort_members m
      where m.earner_id = earners.id
        and is_sponsor_admin(m.sponsor_id)
    )
  );

-- 10) Consent-only update hardening for cohort_members.
--    (a) Column-level privileges restrict the earner's UPDATE to the consent flags.
--    (b) The RLS policy still scopes the row to the calling earner.
drop policy cohort_members_earner_update on cohort_members;

revoke update on cohort_members from authenticated;
grant update (consent_share_skills, consent_share_credentials)
  on cohort_members to authenticated;

create policy cohort_members_earner_update on cohort_members
  for update using (earner_id = auth.uid());
