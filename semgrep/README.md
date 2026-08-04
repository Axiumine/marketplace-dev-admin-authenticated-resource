# Semgrep — marketplace-dev-admin-authenticated-resource

Static analysis (SAST) for this service. Runs via the pinned Docker image, with
**all rules vendored locally** — no network fetch at scan time, fully
reproducible.

## Run

```bash
yarn semgrep        # human-readable report
yarn semgrep:ci     # nonzero exit on findings + SARIF (semgrep.sarif)
```

Both wrap `docker run … semgrep/semgrep:1.172.0 …` — nothing to install locally.
Output is written as your own UID (`-u`), so no root-owned files.

## Layout

| Path | What |
|---|---|
| `custom.yml` | Marketplace-specific rules (secret-in-logs guards) |
| `vendor/typescript.yml` | Vendored registry pack `p/typescript` (74 rules) |
| `vendor/secrets.yml` | Vendored registry pack `p/secrets` (52 rules) |
| `vendor/refresh.sh` | Re-download the vendored packs (manual snapshot update) |

The yarn scripts pass `--config semgrep/`, which loads every rule file in this
directory (custom + vendored) in one shot.

`custom.yml` carries a rule most services do not have —
`marketplace-no-log-reset-secret`. This tier is Admin-authenticated, not public,
but it is the one place the platform hands an imprenditore's reset-password
state (`resetHash`, `resetDateReq`) to a client at all — `GraphQLImprenditoreById`
exposes `resetPwd { resetHash resetDateReq }` and `imprenditoreById.mts` projects
`resetPwd` out of Mongo for it. The hash still authenticates the reset link on
the public tier, so a log line carrying it here would leak the same secret.

## Provenance / reproducibility

- Vendored from `https://semgrep.dev/c/p/<pack>` on **2026-08-01**.
- Semgrep engine pinned to **`semgrep/semgrep:1.172.0`**.
- The committed YAML is a frozen snapshot — the registry can change server-side,
  so scans use these files, not the live registry. To update deliberately:
  `./vendor/refresh.sh`, then review `git diff` and commit.
- `p/javascript` and `p/nodejs` are **not** vendored: the former has the same
  rule-id set as `p/typescript`, the latter is a strict subset of it. Vendoring
  them would only add duplicates.

## ⚠️ Limitation: `.mts` / `.cts` and coverage

**Semgrep 1.172.0 does not recognize the `.mts` (and `.cts`) extension.** This
entire service is written in `.mts` (ESM → `.mjs`). Verified empirically:

| Invocation | Rules that run |
|---|---|
| `semgrep scan --config … src` (plain) | **36** of 124 — only `<multilang>`; every TypeScript rule is skipped |
| current setup (`--scan-unknown-extensions` + explicit files) | **122** — TS + secrets + custom all run |

Cause: semgrep selects a parser by file extension; `.mts` maps to nothing, so
the file is treated as generic and all `typescript`/`javascript` rules are
dropped. (`.mjs` and `.cjs` *are* recognized as JavaScript; only the TS variants
are missing. GitNexus has the same `.mts` gap on this platform.)

### Workaround baked into the yarn scripts

1. **`--scan-unknown-extensions`** — forces semgrep to analyze a file using each
   rule's declared `languages:` regardless of extension. This flag only applies
   to files listed **explicitly on the command line**, not to directory walks.
2. So the scripts enumerate source files themselves:
   `find src -type f \( -name '*.mts' -o -name '*.cts' -o -name '*.ts' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.js' \)`
   and pass them to semgrep, instead of pointing it at the `src/` directory.
3. Vendored packs are **language-targeted** (`typescript`, `secrets`), not the
   broad multi-language packs. Under `--scan-unknown-extensions` a multi-language
   pack would try to parse every `.mts` as Python, Java, Go, Ruby, … — wasted
   work and a meaningless "parsed lines" metric. Targeted packs keep the bypass
   parsing the files only as TS/JS.

### Coverage consequences — read before trusting a clean run

- **Scope is the explicit file list, not `.semgrepignore`.** Because files are
  passed explicitly (not via a directory walk), `.semgrepignore` does **not**
  filter them. Scoping is done entirely by the `find` expression above. A new
  source file under `src/` is covered automatically; a source file **outside
  `src/`**, or with an extension not in the `find` list, is **not scanned**.
  Note that this repo's `.orig` merge leftover (`yarn.lock.orig`) lives at the
  repo root, not under `src/`, and is correctly out of scope either way — the
  `find` list has no `.orig` entry.
- **Parsed-lines ≈ 54.5%, not 100%, and that is expected.** The bypass parses each
  file once per rule-language; a `.mts` parsed as JS (or vice-versa) partially
  fails, dragging the aggregate metric down. It is not a real parse failure of
  the TypeScript rules.
- **Language coverage is deliberately narrow:** TypeScript + secrets + the three
  custom rules. Other-language rule families (python, java, go, …) are excluded
  by design via the targeted vendored packs.
- If semgrep ever ships native `.mts` support, drop `--scan-unknown-extensions`
  and pass `src` directly; the coverage caveats above go away.
