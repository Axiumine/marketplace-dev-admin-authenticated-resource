import { defineConfig } from 'vitest/config'

import { nodeNextResolver } from './vitest.shared.mts'

// Vitest config used by Stryker's vitest-runner (`yarn test:mutation`).
//
// It mirrors the `unit` project of vitest.config.mts and nothing else:
//   - No coverage block. Mutants deliberately break the code, so line-coverage
//     thresholds are meaningless here — the mutation score is the metric.
//   - No `integration` project. Stryker re-runs the suite once per mutant; pointing
//     that at test/integration/*.itest.mts would hammer the real Redis cluster, the
//     real dev MongoDB AND clamd hundreds of times per mutant, and `fileParallelism:
//     false` would serialise all of it within this service's own namespace anyway.
//     Unit tests are Redis/MongoDB/clamd-mocked, so mutant runs stay hermetic and
//     parallelisable.
//
// Keep the plugins/resolve/inline settings in sync with vitest.config.mts — the
// `.mjs -> .mts` NodeNext rewrite and the single-graphql-realm pinning (this service
// also embeds GraphQL objects built by marketplace-common and koa-utils, so both packages
// need inlining alongside graphql/Apollo — see vitest.config.mts's own comment) are
// load bearing, not preferences.
const inlineDeps = [/graphql/, /@apollo\/server/, /@as-integrations/, /@axiumine\/koa-utils/, /@axiumine\/marketplace-common/]

export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/*.test.mts'],
		server: { deps: { inline: inlineDeps } },
		// Same as the `unit` project: set before the sources call `dotenv.config()`,
		// which does not override keys already present in process.env.
		env: {
			NODE_ENV: 'test',
			REDIS_KEY: 'test:'
		}
	}
})
