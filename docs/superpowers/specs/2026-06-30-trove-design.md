# Trove — Design Document

**Date:** 2026-06-30
**Status:** Design approved; pending implementation plan
**Product name:** Trove · **Domain:** trove.io (`.co`/`.me`/`.so` available as backups)

---

## 1. Origin & Strategic Frame

The FY2026 Federal TRIO **Educational Opportunity Centers (EOC, CFDA 84.066A)** notice
includes an **Invitational Priority — "Talent Marketplaces"** that asks for projects which
strengthen individualized career/academic counseling and build scalable data
infrastructure connecting education to workforce outcomes by:

- **(a)** integrating **Learning and Employment Records (LERs)** with **AI-enabled learner
  wallets** → personalized, skills-based pathways to postsecondary success and employment, and
- **(b)** expanding access to **talent marketplaces** composed of credential registries
  (open/linked/interoperable formats), skills-based job-description generators, and LERs
  connecting participants, employers, and education providers through a **common currency
  of skills**.

This priority is **invitational** (N/A points — it signals alignment with the Secretary's
scored Absolute/Competitive priorities but does not itself add to an application's score).
No product on the market cleanly fills this gap, which is the opportunity Trove
addresses.

**Key strategic decisions made during brainstorming:**

| Decision | Choice | Rationale |
|---|---|---|
| Market scope | **Broad** credential wallet for any learner/issuer | Chosen over TRIO-only; TRIO is origin + a sales wedge, not the boundary |
| Relationship to TrioPilot | **Zero coupling** | Separate product, codebase, brand |
| Relationship to Incredify | **Zero coupling** | Wallet holds, never issues; a wallet locked to one issuer isn't a wallet. Incredify is just one of many OB3.0 issuers whose credentials can be imported |
| Primary payer | **Sponsor / B2B2C** (institutions pay, earners free) | Workforce/education programs have budget and are accountable for outcomes; kept flexible |
| Near-term goal | **Shippable MVP** for a real pilot sponsor | No hard deadline, "sooner the better" → tight v1 line |
| Flagship AI feature | **AI advisor chatbot** grounded in skills profile | Most flexible, fewest data dependencies, maps to grant's "counseling" language |

---

## 2. Product Definition

**One-liner:** A free, standards-based digital credential wallet for learners, with an AI
advisor that turns their verified credentials into career and education guidance.

**Positioning:** Like the Parchment Backpack or Credly's earner experience — but
**issuer-agnostic** *and* with an **AI layer** the others lack. It **holds** credentials (it
does not issue them) and **adds intelligence** on top.

**User types (v1):**

- **Earner** (free, always) — collects, organizes, displays, shares verified credentials;
  uses the AI advisor. **Owns their wallet** — data persists even if they leave a sponsor.
- **Sponsor admin** (the payer) — a workforce program / college / CBO / TRIO grantee staffer
  who invites a cohort and sees engagement + (consented) outcomes.
- **Public viewer** (no account) — opens an earner's shared profile and can verify
  credentials are real.

**Core value loop (the thing the pilot must prove):**

1. Sponsor invites a cohort → earners onboard free.
2. Earner imports credentials (OB 2.x/3.0 / VC by file or URL, or manual entry).
3. Trove extracts a **structured skills profile** (O\*NET-normalized).
4. Earner opens the **AI advisor**, which knows their verified skills and answers
   career/learning questions, surfacing job directions and next-credential suggestions inline.
5. Earner publishes a **verifiable public profile** to share with employers.
6. Sponsor sees the cohort engaging and can report outcomes to *its* funder.

---

## 3. Architecture

Single Next.js app on Vercel; Supabase backend; a small set of external services.

```
Next.js app (Vercel)
  /            → marketing + public verify pages
  /app/*       → Earner wallet + AI advisor (auth)
  /sponsor/*   → Sponsor console (auth, role-gated)
  /u/[handle]  → Public verifiable profile (no auth)
  /api/*       → route handlers (import, AI, verify, billing)
        │
   ┌────┴─────┐                ┌──────────────────┐
   │ Supabase │                │ External services │
   │  Postgres+RLS             │  Claude Sonnet 4.6 │
   │  Auth (OTP)               │  Web search (AI)   │
   │  Storage (creds)          │  Stripe (billing)  │
   └──────────┘                │  Postmark (email)  │
                               └──────────────────┘
```

**Key architectural decisions:**

- **Multi-tenant via Postgres RLS.** Sponsors are tenants; earners belong to zero-or-more
  sponsors. **The earner owns the wallet** — credentials/profile persist independent of any
  sponsor. RLS: sponsors see only their cohort; earners see only their own data.
- **Skills engine as an internal service** (`lib/skills/`). All AI reads from the stored,
  normalized skills profile — not raw credentials — keeping AI features decoupled and cheap.
- **AI is server-side only.** All Claude calls go through `/api/` handlers (keys never reach
  the client), with per-earner rate limiting. v1 uses **web search** for live job/learning
  info rather than a paid jobs API.
- **Verification is cryptographic / issuer-side, not a DB lookup.** A public profile proves
  credentials are real by validating the OB3.0/VC signature (or OB2.x hosted-assertion
  `verify` URL) against the issuer — works even for issuers who never heard of Trove.

**Stack:** Next.js + Supabase (Postgres/RLS/Auth/Storage) + Vercel + **Stripe** (billing) +
**Postmark** (email) + **Claude Sonnet 4.6** (advisor + skills extraction; Opus only if a
specific later task needs it). Same toolkit family as TrioPilot for build speed, but an
entirely separate project.

---

## 4. Data Model & Skills Engine (the spine)

**Core tables (Postgres, all behind RLS):**

| Table | Purpose | Key fields |
|---|---|---|
| `earners` | wallet owner | id, handle, display_name, public_profile_enabled |
| `credentials` | one per held credential | earner_id, source (`ob_url`/`ob_file`/`manual`), raw_json, issuer_name, title, issued_date, **verification_status** (`verified`/`unverified`/`failed`), storage_path |
| `skills` | canonical skill vocabulary | id, canonical_name, type (`skill`/`competency`/`occupation`), onet_id |
| `credential_skills` | credentials → skills | credential_id, skill_id, confidence |
| `earner_skills` | rolled-up **skills profile** | earner_id, skill_id, source_count, highest_confidence |
| `sponsors` | paying tenant | id, name, plan, seats, stripe_customer_id |
| `cohort_members` | earner ↔ sponsor | sponsor_id, earner_id, invited_at, status, **consent flags** (what sponsor may see) |
| `advisor_threads` / `advisor_messages` | AI conversation | earner_id, role, content, token_cost |

**Skills engine (`lib/skills/`)** — runs when a credential is added/changed:

1. **Extract** — use OB3.0/CLR structured `alignment`/skill assertions when present;
   otherwise **Claude Sonnet extracts candidate skills** from title + description.
2. **Normalize** — map raw skill strings to a **canonical vocabulary seeded from O\*NET**
   (the U.S. DOL Occupational Information Network — free, public-domain, federal standard;
   ~900+ occupations mapped to skills/knowledge/abilities). This *is* the grant's "common
   currency of skills" and powers skills→occupation matching. v1 seeds a focused subset and
   grows it.
3. **Roll up** — aggregate into `earner_skills`, the profile every AI feature reads.

---

## 5. Credential Import & Verification

**Import paths (v1):**

1. **OB / VC by URL** — paste a hosted credential URL or `.json`; fetch + parse.
2. **File upload** — OB JSON or "baked" `.png`/`.svg` badge with embedded assertion; stored
   in Supabase Storage.
3. **Manual entry** — for non-portable credentials (paper certs, licenses). Marked
   `unverified` but still feeds the skills profile.

> v1 parses **both Open Badges 2.x and 3.0** — most real-world badges today are 2.x; 3.0/VC
> is the newer standard the grant points at. Supporting only 3.0 would leave wallets empty.

**Verification — each credential gets a status:**

- **`verified`** — validated cryptographically (OB3.0/VC signature) *or* confirmed against the
  issuer's hosted assertion (OB2.x `verify` URL).
- **`unverified`** — manual entries / anything uncheckable; shown honestly with a distinct state.
- **`failed`** — verification attempted and did not pass.
- Public profile displays each credential's state with an on-demand "verify" affordance that
  re-checks against the issuer.

**Out of v1:** direct API connectors to Credly/Canvas/LMS; CSV bulk import; *issuing* anything.

---

## 6. AI Advisor (the flagship)

A chat advisor inside the wallet that **knows the earner's verified skills profile** and gives
grounded career/education guidance. Differentiator vs. generic chat: anchored to the earner's
**real, verified credentials** and the **O\*NET** occupation/skills backbone.

**Per-message flow:**

1. Assemble context: `earner_skills` profile + credential list (verified vs not) + any target
   role + recent thread history.
2. Map skills → **O\*NET occupations** and compute "you have X of Y skills for this role"
   gaps **in code** (accurate, cheap — not in the model).
3. Call **Claude Sonnet** with that context + a system prompt scoped to career/education
   guidance for adult learners.
4. Use **web search** only for time-sensitive/external info (current openings, specific
   programs, deadlines), with citations.

**Three topics, unified in one surface (the original three AI features):**

- **"What jobs am I qualified for?"** → occupation matches + live example openings via search.
  *(Seed of the future job-matching subsystem.)*
- **"What should I learn next?"** → skill gap to a target occupation + suggested credential/course types.
- **"How do I get there?"** → open-ended counseling (admissions, financial aid, apprenticeships).

**Cost controls ("not rich" guardrails):** server-side only; per-earner daily message cap;
Sonnet default; gap math in code (no token burn); web search only when the query is external;
trimmed/summarized thread history.

**Honesty/safety guardrails:** framed as *guidance, not a guarantee* of jobs/admission/aid;
flags when reasoning relies on an *unverified* credential.

---

## 7. Sponsor Console & Business Model

**Sponsor admin (v1, minimal):**

- **Invite a cohort** — bulk email invites (Postmark); links earners via `cohort_members`.
- **See engagement** — dashboard: invited / activated / imported ≥1 credential / used advisor.
- **See outcomes (consented)** — aggregate skills coverage, credentials over time, (later) job
  outcomes. **Gated by earner consent** — earners own the wallet and control what the sponsor
  sees; sponsors get aggregate/consented views, never silent surveillance.
- **Billing** — Stripe: seats, plan, invoices.

**Business model:**

- **A (launch): sponsor per-seat subscription**, billed on **active** earners (value
  delivered, not invites). Funded from workforce/education budgets (WIOA, Perkins, TRIO, etc.).
- **B (secondary): capped free individual tier** → optional earner premium (deeper AI, hosted
  portfolio). Seeds organic growth without breaking the free-for-earners promise.
- **C (v2+ flywheel): employer-funded talent marketplace** — employers pay to search
  skills-verified candidates / post opportunities. Requires liquidity first.

**Grant tie-back (the wedge):** a sponsor that is a TRIO/EOC grantee (or any workforce/education
program) can point to Trove as the concrete tool delivering the "AI-enabled learner wallet
+ LER + common currency of skills" the Talent Marketplaces invitational priority describes —
without Trove being locked into the TRIO market.

---

## 8. UX / UI Direction

**Style: "Calm Trust & Clarity."** Generous whitespace, clear hierarchy; **plain, reassuring,
obvious** over clever. Priority order: *legibility → trustworthiness → low cognitive load*.
Verification state is always unmissable; nothing important hides behind hover/gestures.
(Deliberately *not* the "editorial/exaggerated minimalism" the generator first suggested —
wrong for a trust-critical tool for mixed-digital-literacy adults.)

**Typography:** **Lexend** headings (designed to improve reading proficiency — directly serves
low-literacy/first-gen adults) + **Source Sans 3** body. Base ≥16px, line-height 1.5+.

**Color:** Primary `#2563EB` (institutional blue/trust); Accent `#F97316` (one clear CTA per
screen); slate foreground on near-white background. **Semantic verification colors with icon +
text, never color alone:** verified = green + check, unverified = amber + label, failed = red +
icon. Light mode first; dark mode via tokens (not v1-blocking).

**Accessibility baseline (WCAG AA, non-negotiable):** 4.5:1 contrast, visible focus rings,
full keyboard nav, 44×44px touch targets, alt text, `prefers-reduced-motion`, real `<label>`s.
**Mobile-first** — audience is phone-primary; wallet + advisor must excel at 375px.

**Key screens (v1):**

1. **Earner — My Wallet:** credential card grid (title, issuer, date, bold verification chip);
   prominent "Add credential" CTA; entry to the advisor.
2. **Earner — AI Advisor:** clean chat; suggested starter prompts; inline occupation/learning
   cards; plain language.
3. **Public profile `/u/[handle]`:** trustworthy, shareable; live "verify" affordance; no account to view.
4. **Sponsor console:** cohort funnel stats; consented aggregate skills; sortable tables;
   charts with text/table fallback.

**Components:** shadcn/ui + Tailwind (accessible primitives, matches stack).

---

## 9. Decomposition & Scope Boundary

**Subsystems (build order):**

| # | Subsystem | v1? |
|---|---|---|
| 1 | Wallet core (auth, import OB 2.x/3.0+VC by file/URL + manual, store, display, verifiable public profile) | ✅ v1 |
| 2 | Skills engine (O\*NET-normalized profile) | ✅ v1 (spine) |
| 3 | AI advisor (flagship chatbot; job/learning surfaced inline) | ✅ v1 |
| 4 | Sponsor console (invite cohort, engagement, consented outcomes, billing) | ✅ v1 (minimal) |
| 5 | Talent marketplace (employer search/posting) | ⏳ v2+ |
| 6 | Deep issuer connectors (Credly/Canvas/LMS APIs, CSV) | ⏳ progressive |

**Explicitly OUT of v1 (deferred by design):** issuing credentials (never — Incredify's job);
talent marketplace; deep issuer connectors; dedicated job-matching subsystem (v1 surfaces jobs
via the advisor + web search); live learning-catalog integrations; native mobile apps (v1 is
responsive web / PWA at most); multi-language UI (English v1; Spanish is a likely fast-follow
given the audience); SSO / advanced sponsor admin roles.

**v1 = the core value loop end-to-end** (Section 2, steps 1–6).

---

## 10. Open Questions / Flexible Assumptions

- **Business model stays flexible** — sponsor per-seat is the working primary; revisit if a
  better model emerges.
- **Trademark** — "Trove" is a somewhat common brand word (existing non-competing uses in
  recommerce/fintech). Domain securable at trove.io; run a USPTO + state trademark check in the
  **education-software class** before committing spend.
- **O\*NET subset scope** — which occupations/skills to seed first (likely tied to the first
  pilot sponsor's population) is a v1 planning detail.
- **Pricing specifics** — per-seat price points and tiers TBD.
- **First pilot sponsor** — identity/population will inform O\*NET seeding and onboarding copy.
