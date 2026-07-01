// Shared types for the Trove wallet-core (Plan 3). This is the ONLY module every other
// lib/credentials/* file may import from. It imports nothing from the Supabase, Anthropic,
// or jose SDKs — keeping the pure core dependency-free and unit-testable.

/** The three honest verification states (matches the verification_status enum, 0002_core_schema.sql). */
export type VerificationStatus = "verified" | "unverified" | "failed";

/** Matches the credential_source enum in 0002_core_schema.sql. */
export type CredentialSource = "ob_url" | "ob_file" | "manual";

/** Which mechanism produced a VerifyResult (for diagnostics / detail strings). */
export type VerificationMethod = "ob2_hosted" | "vc_jwt" | "none";

/** Normalized credential envelope, mapped onto the credentials columns. */
export interface ParsedCredential {
  title: string;
  issuerName: string;
  issuedDate: string | null; // ISO yyyy-mm-dd or null
  description: string;
}

export interface VerifyInput {
  source: CredentialSource;
  raw_json: unknown;
}

export interface VerifyResult {
  status: VerificationStatus;
  method: VerificationMethod;
  detail: string;
}

/** fetch + clock are injectable so unit tests never touch the network or wall-clock time. */
export interface VerifyOpts {
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

/** Discriminated union describing one import attempt. Built by the Server Actions. */
export type NewCredentialInput =
  | { earnerId: string; source: "ob_url"; raw_json: unknown; sourceUrl: string }
  | {
      earnerId: string;
      source: "ob_file";
      fileBuffer: Buffer;
      fileMime: string;
      fileName: string;
    }
  | {
      earnerId: string;
      source: "manual";
      manual: {
        title: string;
        issuerName: string;
        issuedDate: string | null;
        description: string;
      };
    };

export interface CreateCredentialResult {
  credentialId: string;
  verificationStatus: VerificationStatus;
}
