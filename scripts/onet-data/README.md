# O*NET source data (gitignored)

This directory holds the O*NET Database "Text Files" release, which `node
scripts/seed-onet.mjs` reads directly. Contents are **gitignored** (large, external,
redownloadable).

## Setup

1. Download the Text Files ZIP:
   https://www.onetcenter.org/dl_files/database/db_30_3_text.zip

   (Also linked from https://www.onetcenter.org/database.html#individual-files)

2. Unzip it directly into `scripts/onet-data/`.

3. Run the seed:

   ```bash
   node scripts/seed-onet.mjs
   ```

No manual file renaming or editing is required — `scripts/seed-onet.mjs` resolves
whichever file names are present in the release you downloaded (see next section) and
`lib/skills/onet-parse.ts` tolerates the corresponding column-name differences.

## Release used at seed time

**O*NET database 30.3** (`db_30_3`), retrieved **2026-07-01**.

As of 30.3, the ZIP no longer ships `Skills.txt` or `Technology Skills.txt` directly;
it ships `Essential Skills.txt` + `Transferable Skills.txt` (which together form the
same ~35-element Skills taxonomy) and `Software Skills.txt` (the same data as the old
`Technology Skills.txt`, with its tool-name column renamed `Example` -> `Workplace
Example`). `scripts/seed-onet.mjs` detects which set of files is present and parses
accordingly; it also still supports the older `Skills.txt` / `Technology Skills.txt`
names if a future or past release uses them.

Update this line when re-seeding with a newer release.

Attribution (required): This product incorporates information from the O*NET Database by the
U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). O*NET(R) is a
trademark of USDOL/ETA. O*NET data is public domain / CC BY 4.0.
