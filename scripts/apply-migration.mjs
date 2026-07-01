import { readFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: ".env.local" });

const ref = process.env.SUPABASE_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;
const file = process.argv[2];

if (!ref || !token) {
  console.error("Missing SUPABASE_PROJECT_REF or SUPABASE_ACCESS_TOKEN in .env.local");
  process.exit(1);
}
if (!file) {
  console.error("Usage: node scripts/apply-migration.mjs <path-to-sql>");
  process.exit(1);
}

const query = readFileSync(file, "utf8");
const res = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  }
);

const text = await res.text();
if (!res.ok) {
  console.error(`FAILED (${res.status}) applying ${file}:\n${text}`);
  process.exit(1);
}
console.log(`Applied ${file}. Response: ${text}`);
