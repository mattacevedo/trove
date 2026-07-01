-- Enums
create type verification_status as enum ('verified', 'unverified', 'failed');
create type credential_source as enum ('ob_url', 'ob_file', 'manual');
create type cohort_status as enum ('invited', 'active', 'removed');
create type skill_type as enum ('skill', 'competency', 'occupation');

-- Earners: the wallet owner. Maps 1:1 to an auth user.
create table earners (
  id uuid primary key references auth.users (id) on delete cascade,
  handle citext unique not null,
  display_name text not null default '',
  public_profile_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- Sponsors: the paying tenant.
create table sponsors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free',
  seats integer not null default 0,
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

-- Sponsor staff: which auth users administer a sponsor.
create table sponsor_admins (
  sponsor_id uuid not null references sponsors (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sponsor_id, user_id)
);

-- Cohort membership: earner <-> sponsor, with earner-controlled consent.
create table cohort_members (
  sponsor_id uuid not null references sponsors (id) on delete cascade,
  earner_id uuid not null references earners (id) on delete cascade,
  status cohort_status not null default 'invited',
  consent_share_skills boolean not null default false,
  consent_share_credentials boolean not null default false,
  invited_at timestamptz not null default now(),
  primary key (sponsor_id, earner_id)
);

-- Credentials held by an earner.
create table credentials (
  id uuid primary key default gen_random_uuid(),
  earner_id uuid not null references earners (id) on delete cascade,
  source credential_source not null,
  raw_json jsonb,
  issuer_name text not null default '',
  title text not null default '',
  issued_date date,
  verification_status verification_status not null default 'unverified',
  storage_path text,
  created_at timestamptz not null default now()
);
create index credentials_earner_idx on credentials (earner_id);

-- Canonical skill vocabulary (seeded from O*NET in Plan 2).
create table skills (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  type skill_type not null default 'skill',
  onet_id text unique
);
create unique index skills_name_type_idx on skills (canonical_name, type);

-- Credential -> skill links.
create table credential_skills (
  credential_id uuid not null references credentials (id) on delete cascade,
  skill_id uuid not null references skills (id) on delete cascade,
  confidence real not null default 1.0,
  primary key (credential_id, skill_id)
);

-- Rolled-up skills profile (the thing the AI reads).
create table earner_skills (
  earner_id uuid not null references earners (id) on delete cascade,
  skill_id uuid not null references skills (id) on delete cascade,
  source_count integer not null default 1,
  highest_confidence real not null default 1.0,
  primary key (earner_id, skill_id)
);

-- AI advisor conversation history.
create table advisor_threads (
  id uuid primary key default gen_random_uuid(),
  earner_id uuid not null references earners (id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now()
);

create table advisor_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references advisor_threads (id) on delete cascade,
  earner_id uuid not null references earners (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  token_cost integer not null default 0,
  created_at timestamptz not null default now()
);
create index advisor_messages_thread_idx on advisor_messages (thread_id);
