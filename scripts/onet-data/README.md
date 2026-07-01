# O*NET source data (gitignored)

Place the three tab-delimited O*NET Database text files here (they are **gitignored**):

- `Occupation Data.txt`
- `Skills.txt`
- `Technology Skills.txt`

Download the "Text Files" ZIP from:
https://www.onetcenter.org/database.html#individual-files

Direct URL used at seed time:
https://www.onetcenter.org/dl_files/database/db_30_3_text.zip

Release used at seed time: **O*NET database 30.3** (`db_30_3`), retrieved **2026-07-01**.
Update this line when you re-seed with a newer release — the parsers do not hardcode a
version check and tolerate any release with the same file shape.

## Content-model change in 30.3 (May 2026 release) — file prep required

As of the 30.3 "Text Files" ZIP, O*NET no longer ships `Skills.txt` or
`Technology Skills.txt` directly. The ZIP instead contains:

- `Essential Skills.txt` and `Transferable Skills.txt` (the old unified "Skills" domain
  split into basic-skills 2.A.x and cross-functional 2.B.x element groups — same column
  shape as the old `Skills.txt`: `O*NET-SOC Code`, `Element ID`, `Element Name`,
  `Scale ID`, `Data Value`, ...). Together they cover the full fixed ~35-element Skills
  taxonomy (10 + 25 elements as of 30.3).
- `Software Skills.txt` (the old `Technology Skills.txt` renamed, with its tool-name
  column renamed `Example` -> `Workplace Example`, plus a new `In Demand` column added).
  `Hot Technology` is unchanged.

Because `lib/skills/onet-parse.ts` is a pure module with no filesystem/network access,
it stays name-agnostic by design — do NOT special-case the 30.3 filenames inside the
parser. Instead, build the three brief-shaped files this README documents by hand from
the ZIP contents before running `node scripts/seed-onet.mjs`:

```bash
# from the unzipped db_30_3_text/ directory, writing into scripts/onet-data/
cp "Occupation Data.txt" "scripts/onet-data/Occupation Data.txt"

{ head -1 "Essential Skills.txt"; tail -n +2 "Essential Skills.txt"; tail -n +2 "Transferable Skills.txt"; } \
  > "scripts/onet-data/Skills.txt"

{ head -1 "Software Skills.txt" | sed 's/Workplace Example/Example/'; tail -n +2 "Software Skills.txt"; } \
  > "scripts/onet-data/Technology Skills.txt"
```

If a future O*NET release reverts to (or keeps) plain `Skills.txt` / `Technology
Skills.txt` files with the classic column names, just copy them in directly — no prep
needed.

Attribution (required): This product incorporates information from the O*NET Database by the
U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). O*NET(R) is a
trademark of USDOL/ETA. O*NET data is public domain / CC BY 4.0.
