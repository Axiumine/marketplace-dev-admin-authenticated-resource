# Test quality policy — 100% coverage **and** 100% mutation score, no exceptions

This service requires **100% test coverage on every metric** — statements, branches,
functions, and lines — **and a 100% Stryker mutation score**. Both are hard gates, not targets.

They answer different questions, which is why both exist:

| Gate | Question it answers |
|---|---|
| coverage | did a test *execute* this line? |
| mutation | would a test *fail* if this line were wrong? |

100% coverage with weak assertions is the normal failure mode, and it is invisible to the
coverage number. Mutation testing is what falsifies it: Stryker rewrites `src/` one small
change at a time (`true` → `false`, a string → `""`, a block → `{}`) and re-runs the suite.
A mutant that *survives* is an edit no test noticed.

## The rule

If coverage is below 100% on any metric, the fix is one of:

1. **Add the missing tests** for the uncovered lines / branches / functions.
2. **Delete the code** if it is unreachable or dead.

If the mutation score is below 100%, the fix is one of:

1. **Strengthen the assertion** that should have caught the mutant.
2. **Delete the code** if the mutant proves the branch is dead.
3. **Document an equivalent mutant** with `// Stryker disable next-line <Mutator>: <why>` —
   only when the mutated code provably cannot behave differently on any reachable input.

**Never** lower a threshold to make a run pass. The thresholds are the specification;
red means the work is not done, not that the number is wrong.

## Where it is enforced

| Layer | File | What it does |
|---|---|---|
| Local test run | `vitest.config.mts` → `test.coverage.thresholds` | `yarn test:cov` exits non-zero if any metric < 100% |
| Local mutation run | `stryker.config.mjs` → `thresholds.break` | `yarn test:mutation` exits non-zero if the score < 100 |
| Git `pre-commit` | `.githooks/pre-commit` | blocks the commit if `yarn test:cov` **or** the Qodana scan fails |
| Git `pre-push` | `.githooks/pre-push` | blocks the push if `yarn lint:check`, `yarn test:cov`, `yarn test:mutation` **or** the Qodana scan fails |

The coverage layers read the same coverage run (vitest, v8 provider, lcov → `coverage/lcov.info`,
`all: true` over `src/**/*.mts`). Change coverage config in `vitest.config.mts` only.
There is no `qodana.yaml` in this service yet; when one is added it gets the same
`failureConditions.testCoverageThresholds` (`total`/`fresh` = 100) as the logout service —
Qodana has no mutation gate of its own, so `pre-push` stays the only place the mutation score
is enforced.

Both hooks run the scan on purpose. `git merge --no-ff` never fires `pre-commit` — git runs that
hook for `git commit` only — so the merge commit, the one revision that reaches `origin`, is the
single commit no pre-commit scan ever sees. And Qodana Cloud files each report under the branch
it ran on, so a repo scanned only at commit time never produces a `main`-tagged report to
baseline against. Each hook hands `qodana.sh` `SKIP_TESTS=1`, reusing the `coverage/lcov.info`
its own coverage step just wrote rather than letting the script regenerate it with a test run
whose failure it swallows. `SKIP_QODANA=1` skips the scan alone; the coverage and mutation gates
stay.

## Two projects, one coverage report

`vitest.config.mts` defines two projects; `yarn test:cov` runs both and aggregates coverage:

| Project | Files | Datasources | Purpose |
|---|---|---|---|
| `unit` | `test/*.test.mts` | mocked | pure logic, error paths, prod branches — fast, offline |
| `integration` | `test/integration/*.itest.mts` | **real Redis cluster + real MongoDB + real clamd** | boots the server via `start()` and drives it over HTTP |

This is the **Admin resource tier**: every request goes through
`authorizationAuthenticatedResourceHandler()`, which reads
`Authorization: Bearer access:<token>` and looks the session up in Redis. There is no cookie
and no Keygrip here — the refresh cookie belongs to the authorization services, which are also
what writes the session this one reads.

`start()` additionally arms the antivirus (`initClamScan()`) before the server is built, so the
integration project needs **clamd listening on `/var/run/clamav/clamd.ctl`** on top of the two
datasources. A missing clamd is a boot failure by design — an upload must never reach disk
unscanned — and the unit project covers that failure path with a mock.

The integration project uses the `REDIS_*` / `MONGODB_URI` values from `.env` (loaded by the
sources' own `dotenv.config()`). It overrides only the keyspace prefix
(`REDIS_KEY=marketplaceDev:itest:adminAuthenticatedResource:`, this service's own namespace under the
ACL-allowed `marketplaceDev:itest:` stem), `PORT=0` (ephemeral) and `INTROSPECTION_CODE`. Run just one
side with `yarn test:unit` / `yarn test:integration`.

Consequence: the coverage gate — and therefore `pre-push` — needs Redis, MongoDB and clamd
reachable. That is intentional: 100% here means the server was really booted and really talked
to all three, not that a mock returned the expected value.

**The integration suite never writes to MongoDB.** It seeds and deletes its own access sessions
inside the isolated Redis namespace, and touches MongoDB only through `imprenditoriStats`
(a `countDocuments()` read). Exercising `imprenditoreAdd` / `imprenditoreDel` /
`imprenditoreUpdate` for real would mean writing to the dev database and satisfying the full
`$jsonSchema` validator; those resolvers are covered by the unit project instead, with
`tryCatchRethrow` left unmocked so failures really travel through it.

## A note on the `graphql` realm

`vitest.config.mts` inlines `@thedoctorweb_agency/marketplace-common` and `@axiumine/koa-utils`
alongside `graphql` / `@apollo/server` / `@as-integrations`. The schema embeds GraphQL objects
those two packages build (`GraphQLIndirizzoBaseFrag`, `GraphQLPositionFrag`,
`GraphQLInputAnagraficaImprenditore`, `GraphQLInputLogin`), so they have to see the *same*
transformed `graphql` copy as the sources — otherwise graphql refuses the type with
"Cannot use GraphQLObjectType … from another module or realm". The bare `/graphql/` pattern
already covers `graphql-scalars`, `graphql-upload` and `graphql-depth-limit`.

The same split is why error assertions match on `.message` rather than `instanceof GraphQLError`.

## Enabling the hook

The `pre-push` hook lives in `.githooks/` (tracked in git). It is activated by:

```bash
git config core.hooksPath .githooks
```

The `prepare` script in `package.json` runs this automatically on `yarn install`, so a
fresh clone is gated after the first install. To verify:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Server boot and Sentry init are covered — do not exclude them

`src/index.mts` (Koa/Apollo wiring, upload middleware, routing, shutdown) and
`src/instrument.mts` (Sentry init) reach 100% through the **integration** project, which boots
the real server and hits `/admin-authenticated-resource`, `/health` and an unknown path over
HTTP. They are **not** `v8 ignore`d and must stay that way — the only `v8 ignore` block is the
entrypoint tail of `index.mts` (the `if (NODE_ENV !== 'test')` bootstrap that registers signal
handlers and calls `start()`), which cannot run under the test process without killing the
worker via `process.exit`. Every function it wires (`start`, `gracefulShutdown`,
`onUnhandledRejection`, `onUncaughtException`) is exercised directly by tests, so the ignored
block contains only the wiring, no logic.

## What the port deleted or fixed

Reaching 100% surfaced code that could not be covered because it could not run. Recorded here
so the deletions are not mistaken for lost features:

- `src/lib/getWeek.mts` and `src/lib/tipoPagamento.mts` — **deleted**. QPANEL car-leasing
  leftovers (NLT / CVT / targaprova payment types, ISO week helper) with zero importers
  anywhere in the platform.
- `authorizationAuthenticatedResourceHandler` — the `x-introspectioncode` bypass dereferenced a
  missing `Authorization` header (`authorization!.startsWith(...)`) and threw a `TypeError`,
  so it could never succeed and the `if (!introspection)` guard below it was unreachable.
  Guarded with `!introspection &&`, matching the three sibling services. The dead
  `accessToken !== ''` check and an unused `operationName` block went with it.
- `imprenditoreAdd` — `return Imprenditore.create(doc)` inside a `try` meant the promise escaped
  before the `catch` could see it, and the mutation resolved to a Mongoose document against a
  declared `Boolean!`. Now `await`ed, like its two sibling mutations.

Two more defects are **documented in the tests but deliberately left alone**, because fixing
them is a domain decision rather than a test-porting one:

- `imprenditorePuntiVendita` filters `{ _id: args.idImprenditore }` instead of
  `{ idImprenditore: args.idImprenditore }`, so it matches nothing in practice.
- `funImprenditoreUpdate` treats `modifiedCount === 0` as a failure, so re-saving an unchanged
  anagrafica answers 500.

## Mutation testing — what is mutated, and what is not

`yarn test:mutation` runs Stryker (`stryker.config.mjs`) with the **vitest** runner over
`vitest.mutation.config.mts`. One deliberate scope decision, which would otherwise show up as
permanent survivors:

| Setting | Why |
|---|---|
| runs the **`unit` project only** | Stryker re-runs the suite once per mutant. Pointing that at `test/integration/*.itest.mts` would hammer the real Redis cluster, the real dev MongoDB and clamd hundreds of times per mutant, where `fileParallelism: false` serialises everything within this service's own namespace. Unit tests are Redis/MongoDB/clamd-mocked, so mutant runs stay hermetic and parallel. |

There is no `ignoreStatic`. It looked necessary once: a mutant in module-load code (`name:
'GraphQLPuntoVendita'`, `description: '…'`, the GraphQL type/field object literals) appeared
unkillable, because the module under test was imported at the top of the test file — the mutant
ran during Vitest's file-collection phase, before any test started, so Stryker's per-test
coverage tracking could never attribute it to a test. That was a test-authoring bug, not a real
limitation: `test/schema.test.mts` now imports `queries.mts`/`mutations.mts` from inside the
`it` body that needs them (a `beforeAll` is not enough — Vitest reports a `beforeAll` throw as
every descendant test "skipped", not "failed", which Stryker's coverage-perTest run reads as no
kill), and the field-level `description` strings get their own assertions. Static mutants are
fully in scope here and all of them are killed.

`!src/graphQLApi/schema/types/**` is the only `mutate` exclusion. Every file under it is
nothing but `new GraphQLObjectType({ name, fields: () => ({...}) })` — field names,
`GraphQLNonNull` wrapping and scalar choices, with no `resolve` of its own and no branching
(checked directly, file by file). `test/schema.test.mts` already asserts the field *names* of
every one of these types via introspection, which is what schema drift should be caught by; it
has no reason to assert the `GraphQLNonNull` wrapping or scalar choice of each field, because
that is schema shape, not application logic.

**`index.mts` and `instrument.mts` are not excluded, unlike the logout service's Stryker
config.** There, entry/bootstrap wiring is only reachable through the integration project,
which its mutation run does not execute, so excluding it is the only way to avoid pure
`NoCoverage` noise. Here, `test/index.unit.test.mts` boots the real Koa/Apollo server built by
`createServer()` — over a real ephemeral-port `http.Server`, with only the datasources
(Redis/MongoDB/clamd) mocked — and drives it with real HTTP requests (the CSRF-prevention
branch, the introspection-code and bearer-token auth branches, `/health`, an unknown path, a
graceful-shutdown-under-load race). That is enough for `index.mts` to be fully covered and
fully mutated **inside the unit project alone**, so it stays in scope instead of being carved out.

### Equivalent mutants

Two mutants are annotated in `src/index.mts` with `// Stryker disable`, each above a comment
carrying the reachability argument:

- the `graphqlUploadKoa({ maxFileSize: 30000000, maxFiles: 10 })` options object — no query or
  mutation in this service's schema declares a `GraphQLUpload` argument (checked directly in
  `queries.mts` / `mutations.mts`), and `graphqlUploadKoa`'s own source only reads those limits
  inside its `multipart/form-data` branch. Every request this service actually serves is JSON,
  so that branch is never taken and the limits can never produce an observable difference here.
- the entrypoint tail (`if (process.env.NODE_ENV !== 'test') { … }`) — the same guard already
  carries a `/* v8 ignore start/stop */` for the identical reason: both vitest.config.mts
  projects set `NODE_ENV=test`, so the condition is false on every reachable test input, under
  either project.

Do not add to this list without the same kind of argument. "I could not think of a test" is not
an equivalence proof.

### Writing tests that kill

The failure mode Stryker exposed most often here was an assertion that passes for the original
*and* the mutant — `rejects.toThrow()` with no message, `toHaveBeenCalled()` with no argument
matcher, or a `describe` block that never checked a mock's call count at all. Every assertion in
`test/authorizationAuthenticatedResourceHandler.test.mts` pins the exact rejection message
(`'Precondition Failed'`, `'Token Required'`, `'Invalid Token'`, …), and
`test/index.unit.test.mts` pins exact call arguments (`toHaveBeenCalledExactlyOnceWith`) rather
than just call presence — that specificity is what keeps mutants from surviving quietly inside
an already-green suite.

Current state (measured by `yarn test:mutation`, this session): **252 mutants instrumented, 233
tested and killed, 19 ignored, 0 survived**, score 100.00, ~25 s. The 19 ignored mutants are the
ones excluded by the `// Stryker disable next-line`/`// Stryker disable all` directives already
documented above (the entrypoint wiring block and the `graphqlUploadKoa` options literal) — they
are not run, so they are neither "killed" nor a live risk.

## Running it

```bash
yarn test:cov       # coverage + threshold check (the source of truth)
yarn test:mutation  # Stryker; report at reports/mutation/mutation.html
```

`git push` runs both, in that order, and blocks on either.
