# marketplace-dev-admin-authenticated-resource

Backend svc 2 of 9. Admin tier, resource concern. Port 4024.

**Read parent first** — [`../../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
Tier/concern split, port table, terminology, auth model live there. Not here.

| Need | File |
|---|---|
| what this svc is, its GraphQL surface, its traps | [`README.md`](./README.md) |
| hook internals, gate order, node selection, mutation-gate rationale | [`REPO.md`](./REPO.md) |
| GitNexus rules, this repo's registry name | [`AGENTS.md`](./AGENTS.md) |
| anything cross-repo | parent `CLAUDE.md` |

## ⚠️ NEVER run the mutation gate by hand

`yarn test:mutation` is **hook-only** — only `pre-push` runs it, never a commit, never a check on one
file, never to confirm a survivor is fixed. The threshold stays 100 regardless. To reproduce a survivor,
apply the mutant by hand in the source and run `yarn test` instead — seconds, and it names the tests that
should have failed. Full rationale: [`REPO.md`](./REPO.md).
⚠️ Since ADR-055 the script has a second caller, `.github/workflows/gates.yml`, which runs it on
every pull request — two callers, both automated, and a hand is neither.

## Rules

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merge = user decision alone.
- Merged → delete branch: `git branch -d <slug>`. `-d` only. `-D` never.
- **No remote.** Push-on-request: no `git push` unless the user asked for it in that message.
- **Never lower a coverage or mutation threshold, and never remove a gate.** Threshold miss → write the
  missing test. Bypasses (`SKIP_QODANA=1`, `--no-verify`) are gate removals: use only when the user says so.
- Tabs, not spaces. eslint + prettier both enforce.
- English only — identifiers, comments, fixtures. No exception.
- Domain query/mutation → **resource** svc. Token lifecycle → **authorization** svc.
- **Run `impact({target, repo})` before editing a symbol; `detect_changes()` before committing.** `repo:`
  is mandatory and must be a `marketplace*` registry name.

## Gates

commit → secret guard, lint, coverage, Qodana. push → same + semgrep (SAST) + trivy (dependency
advisories) + mutation. All blocking. Why: [`REPO.md`](./REPO.md).
