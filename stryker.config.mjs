/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 989 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 59s
	 *   concurrency 28 → 24s
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same 19 Ignored and 3 Timeout, the same files, lines and mutators — identical sets, not
	 * equal counts.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	// Mutation score is a push gate — see COVERAGE.md. `break` fails the run (exit 1)
	// below this score, which is what the pre-push hook keys off. Raise it as tests
	// improve; never lower it to make a run pass.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and `.stryker-tmp`
	 * — `ignorePatterns` itself defaults to empty, and `.qodana/` here runs to tens of megabytes.
	 *
	 * It is not only wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts',
		// GraphQL type declarations under schema/types/: every file there is nothing but
		// `new GraphQLObjectType({ name, fields: () => ({...}) })` — field names, GraphQLNonNull
		// wrapping and scalar choices, with no resolver of its own and no branching. Verified
		// by reading every file in the directory (GraphQLAdminInfoAfterLogin,
		// GraphQLShopOwnerActiveTbl, GraphQLShopOwnerById, GraphQLShopOwnerAddress,
		// GraphQLPuntiVendita — none defines a `resolve`). test/schema.test.mts already asserts
		// the field *names* of every one of these types via introspection, which is what schema
		// drift should be caught by; it has no reason to assert the GraphQLNonNull wrapping or
		// scalar choice of each field, because that is schema shape, not application logic.
		// Mutating those would only produce noise, not signal.
		'!src/graphQLApi/schema/types/**'
	]
}
