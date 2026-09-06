import { readFile } from 'node:fs/promises'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/*
 * The `no-restricted-syntax` block in `eslint.config.js`, proved one selector at a time.
 *
 * A rule nobody exercises is a comment. Each fixture below is the *exact* shape the rule exists to
 * refuse — including the assignment form the audit actually found, which a `Property`-only selector
 * would have let through — and the last one is the compliant shape, which must stay silent.
 *
 * The fixtures are `.mts.fixture` rather than `.mts` on purpose: a real `.mts` under `test/` would be
 * linted by `yarn lint` and report the very findings it is here to contain, and adding it to `ignores`
 * would then hide it from this suite too. They are read as text and linted through `lintText` at a
 * `test/`-shaped path, which is the config this block applies to along with every other file.
 */

const FIXTURES = new URL('./fixtures/restrictedSyntax/', import.meta.url)

const TLS_MESSAGE = 'certificate verification stays on.'
const PII_MESSAGE = 'the blanket Sentry PII flag is absent by decision, not set to false.'
const BODY_MESSAGE = 'the request body is never captured.'
const HOOKS_MESSAGE = '`beforeSend` and `beforeSendTransaction` are wired together or not at all.'

const lintFixture = async (name: string) => {
	const code = await readFile(new URL(`${name}.mts.fixture`, FIXTURES), 'utf8')
	const [result] = await new ESLint().lintText(code, { filePath: 'test/restrictedSyntaxFixture.mts' })

	return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax')
}

describe('the no-restricted-syntax block fires on every shape it names', () => {
	it.each([
		['assignment-reject-unauthorized', TLS_MESSAGE],
		['property-reject-unauthorized', TLS_MESSAGE],
		['computed-property-reject-unauthorized', TLS_MESSAGE],
		['send-default-pii', PII_MESSAGE],
		['member-node-tls-reject-unauthorized', TLS_MESSAGE],
		['literal-node-tls-reject-unauthorized', TLS_MESSAGE],
		['max-incoming-request-body-size', BODY_MESSAGE],
		['before-send-without-transaction', HOOKS_MESSAGE]
	])('reports %s exactly once', async (fixture, expected) => {
		const messages = await lintFixture(fixture)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(expected)
		expect(messages[0]?.severity).toBe(2)
	})
})

describe('the block stays silent on the shape the services carry', () => {
	it('reports nothing on the compliant init options', async () => {
		expect(await lintFixture('compliant')).toStrictEqual([])
	})
})

const REDIS_DEL_MESSAGE = 'BCON-08: one Redis key per `del`.'

/*
 * BCON-08 and NFR-SC03, and RISK_REGISTER R32.
 *
 * Redis is a cluster here, and a multi-key `DEL` across two slots is a runtime `CROSSSLOT` error rather
 * than a slow path. The convention that answers it — one key per call, batched with `Promise.all` — was
 * prose in three documents and checked by nothing, while `@redis/client` types the batched form as legal:
 * a violation compiles, passes review as ordinary Redis code, and fails in production on the path that
 * revokes a session.
 *
 * Three fixtures, because the batch is spelled three ways and a rule that names one lets the other two
 * through. The fourth is the shape this repo already carries and must stay silent — a rule that also
 * refused the compliant form would be reverted within a day, which is the failure mode a one-directional
 * test never catches.
 */
describe('the one-key-per-del rule fires on every batched shape', () => {
	it.each([
		['redis-del-two-arguments', REDIS_DEL_MESSAGE],
		['redis-del-array-argument', REDIS_DEL_MESSAGE],
		['redis-del-spread-argument', REDIS_DEL_MESSAGE]
	])('reports %s exactly once', async (fixture, expected) => {
		const messages = await lintFixture(fixture)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(expected)
		expect(messages[0]?.severity).toBe(2)
	})

	it('reports nothing on the per-key shape the session code carries', async () => {
		expect(await lintFixture('redis-del-compliant')).toStrictEqual([])
	})
})

const SEED_MESSAGE = 'An integration test seeds through the raw driver'

/*
 * RISK_REGISTER R33, and docs/testing.md "Integration test conventions".
 *
 * The convention — seed through the driver, never through a model — was prose, and prose is checked by
 * nobody. `no-restricted-imports` checks it now, and the three cases below are the three things that
 * have to be true at once: it fires inside `test/integration/**`, it stays out of the way of the unit
 * tests one directory up, which mock these very models by name, and it says nothing about the raw-driver
 * seed the harnesses already use. A rule proved only in the first direction is a rule that could be
 * scoped to every file on the platform and still look correct from here.
 *
 * Both paths are invented names rather than real files, which is safe for this rule and not for every
 * one: `no-restricted-imports` reads the import declaration alone, so no TypeScript program has to
 * contain the path the way `SRC_PATH` above must.
 */
const ITEST_PATH = 'test/integration/restrictedImportsFixture.itest.mts'
const UNIT_TEST_PATH = 'test/restrictedImportsFixture.mts'

const lintImports = async (name: string, filePath: string) => {
	const code = await readFile(new URL(`${name}.mts.fixture`, FIXTURES), 'utf8')
	const [result] = await new ESLint().lintText(code, { filePath })

	return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-imports')
}

describe('an integration test may not seed through a Mongoose model', () => {
	it('reports the model import exactly once under test/integration/', async () => {
		const messages = await lintImports('integration-seed-via-model', ITEST_PATH)

		expect(messages).toHaveLength(1)
		expect(messages[0]?.message).toContain(SEED_MESSAGE)
		expect(messages[0]?.severity).toBe(2)
	})

	it('stays silent on the same import in a unit test, which mocks the model by name', async () => {
		expect(await lintImports('integration-seed-via-model', UNIT_TEST_PATH)).toStrictEqual([])
	})

	it('stays silent on the raw-driver seed every harness here already carries', async () => {
		expect(await lintImports('integration-seed-via-raw-driver', ITEST_PATH)).toStrictEqual([])
	})
})
