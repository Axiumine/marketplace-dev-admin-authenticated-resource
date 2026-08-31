import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'

import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const initClamScan = vi.fn()
const setupFieldEncryption = vi.fn()
const disconnectAllDatabases = vi.fn()
const hGetAll = vi.fn()
const startRetentionSweeper = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// redisClient.hGetAll backs the real (non-introspection) auth path exercised below by
// "wires the Koa ctx into the resolver context" — everything else here only drives start()'s
// failure paths, which never reach hGetAll.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: { hGetAll } }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
vi.mock('@axiumine/koa-utils/files/scanVirus', () => ({ initClamScan }))
// Mocked, not real: the real one reads the platform's 96-byte master key off disk and mints data
// keys in the key vault, neither of which a unit test may touch. What is under test here is only
// that start() calls it, and calls it after the connection it borrows exists.
vi.mock('@axiumine/marketplace-common/encryption/setupFieldEncryption', () => ({ setupFieldEncryption }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))
// Mocked because the real one arms an hourly interval and fires a sweep immediately, against a
// MongoDB nothing has connected here — every start() in this file would leave a background job
// buffering writes behind it. Its own behaviour is covered by test/startRetentionSweeper.test.mts;
// what start() owes is only the call, in the right place, on a boot that actually completed.
vi.mock('@lib/retention/startRetentionSweeper.mjs', () => ({ startRetentionSweeper }))
// Spies on the real ApolloServerPluginDrainHttpServer (delegates to the actual implementation via
// importOriginal, so every other test here still gets genuine drain behaviour) purely so the
// "wires ApolloServerPluginDrainHttpServer" test below can assert it was actually called with the
// server's own httpServer. Node's own http.Server#close() (v24: httpServerPreClose ->
// closeIdleConnections) already destroys idle keep-alive sockets on its own — verified directly by
// timing a bare server.close() with an open idle keep-alive connection and no plugin at all, which
// closed in ~1ms — so racing gracefulShutdown() against a clock cannot tell the plugin's presence
// from its absence here. Asserting the wiring call is the only reliable way to kill a mutant that
// empties the `plugins:` array.
vi.mock('@apollo/server/plugin/drainHttpServer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@apollo/server/plugin/drainHttpServer')>()
	return { ApolloServerPluginDrainHttpServer: vi.fn(actual.ApolloServerPluginDrainHttpServer) }
})

const {
	ENDPOINT,
	REQUIRED_ENV_VARS,
	checkRequiredEnv,
	buildValidationRules,
	healthResponse,
	logListening,
	gracefulShutdown,
	onUnhandledRejection,
	onUncaughtException,
	createServer,
	start
} = await import('../src/index.mts')

describe('checkRequiredEnv', () => {
	/*
	 * ⚠️ The whole list, by value and in order, rather than a length or a `toContain`. This array is a
	 * contract with every environment the service is deployed into, and both ways of breaking it are
	 * silent: a name dropped from here turns a fatal misconfiguration into a service that starts and
	 * fails later, at a request, somewhere that does not name the cause; a name added here and read
	 * nowhere makes every environment carry a value that does nothing. A length check passes a swap and
	 * a `toContain` passes an addition, so neither notices the change. The order is asserted too — the
	 * boot names the *first* missing variable, and that is the one an admin goes looking for.
	 */
	it('requires exactly these 16 variables, in this order', () => {
		expect(REQUIRED_ENV_VARS).toStrictEqual([
			'PORT',
			'REDIS_IS_CLUSTER',
			'REDIS_DB1_HOST',
			'REDIS_DB2_HOST',
			'REDIS_DB3_HOST',
			'REDIS_DB1_PORT',
			'REDIS_DB2_PORT',
			'REDIS_DB3_PORT',
			'REDIS_USERNAME',
			'REDIS_PASSWORD',
			'REDIS_KEY',
			'MONGODB_URI',
			'CSFLE_MASTER_KEY_PATH',
			'CSFLE_KEY_VAULT_NAMESPACE',
			'INTROSPECTION_CODE',
			'KEYGRIP_KEK'
		])
	})

	it('passes when every required variable is set', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	// throwInternalError, not `new Error`: the client-facing message stays generic and the missing
	// variable name travels in extensions.description.
	it('raises a 500 naming the first missing variable in the description', () => {
		expect(() => checkRequiredEnv({})).toThrow('Internal Server Error')

		try {
			checkRequiredEnv({})
		} catch (e) {
			const extensions = (e as { extensions: { description: string; http: { status: number } } }).extensions
			expect(extensions.http.status).toBe(500)
			expect(extensions.description).toContain(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
		}
	})
})

describe('buildValidationRules', () => {
	it('is empty outside production', () => {
		expect(buildValidationRules({ NODE_ENV: 'test' })).toEqual([])
	})

	it('caps depth and blocks introspection in production', () => {
		expect(buildValidationRules({ NODE_ENV: 'production' })).toHaveLength(2)
	})
})

describe('healthResponse', () => {
	it('reports OK with a round-trippable ISO timestamp', () => {
		const res = healthResponse()
		expect(res.status).toBe('OK')
		expect(res.timestamp).toBe(new Date(res.timestamp).toISOString())
	})
})

describe('logListening', () => {
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureMessage.mockReset()
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	// The real call site (start(), src/index.mts) invokes logListening() with NO argument, so it
	// falls back to process.env. An explicit-argument call exercises a path production never takes —
	// that gap is exactly how this service shipped a banner reading ".../undefined:PORT..." after
	// HOSTNAME was removed from the env template while this function still referenced it. Stubbing
	// process.env and calling with zero arguments is the only way to catch a regression here.
	it('reads process.env when called with no argument, as the real start() call site does', () => {
		vi.stubEnv('NODE_ENV', 'test')
		vi.stubEnv('PORT', '4024')

		logListening()

		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4024/admin-authenticated-resource for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors the exact banner to Sentry in production, called with no argument', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('PORT', '80')

		logListening()

		const expected = 'Serving http://*:80/admin-authenticated-resource for production.'
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(expected, 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith(expected)
	})

	it('logs to the console only, outside production', () => {
		logListening({ NODE_ENV: 'test', PORT: '4024' })
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4024/admin-authenticated-resource for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors the banner to Sentry in production, given explicit args', () => {
		logListening({ NODE_ENV: 'production', PORT: '80' })
		const expected = 'Serving http://*:80/admin-authenticated-resource for production.'
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(expected, 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith(expected)
	})
})

describe('gracefulShutdown', () => {
	beforeEach(() => {
		captureMessage.mockReset()
		disconnectAllDatabases.mockReset()
	})

	it('drains Apollo, closes the server and disconnects with code 0', async () => {
		const apolloServer = { stop: vi.fn().mockResolvedValue(undefined) }
		const httpServer = { close: vi.fn((cb: () => void) => cb()) }

		await gracefulShutdown('SIGTERM', apolloServer as never, httpServer as never)

		expect(captureMessage).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully...')
		expect(apolloServer.stop).toHaveBeenCalledTimes(1)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(0)
	})
})

describe('process handlers', () => {
	let exit: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	// Deliberately non-fatal on this tier — see the comment on onUnhandledRejection.
	it('onUnhandledRejection reports the reason without killing the process', () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)
		expect(exit).not.toHaveBeenCalled()
	})

	it('onUncaughtException reports the error and exits 1', () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(exit).toHaveBeenCalledWith(1)
	})
})

/**
 * The boot mocks both `start` suites open a test with: every dependency `start` awaits answers, and every
 * variable `requireEnv` reads has a value, so what each test arms afterwards is only the failure it is
 * about.
 *
 * `disconnectAllDatabases` is reset by the failure path alone — the success path never reaches it, and a
 * suite that resets a mock it does not use hides the day that stops being true.
 */
function armBootMocks(): void {
	captureException.mockReset()
	RedisConnect.mockReset().mockResolvedValue(undefined)
	MongoDBConnect.mockReset().mockResolvedValue(undefined)
	initClamScan.mockReset().mockResolvedValue(undefined)
	setupFieldEncryption.mockReset().mockResolvedValue(undefined)
	startRetentionSweeper.mockReset()
	for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
}

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		disconnectAllDatabases.mockReset()
		armBootMocks()
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		errorLog.mockRestore()
		vi.unstubAllEnvs()
	})

	it('reports to Sentry and disconnects with code 1 when MongoDB fails to connect', async () => {
		const error = new Error('mongo boom')
		MongoDBConnect.mockRejectedValueOnce(error)

		await start()

		expect(MongoDBConnect).toHaveBeenCalledTimes(1)
		expect(errorLog).toHaveBeenCalledExactlyOnceWith('error', error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})

	// Both datasources are opened by the same Promise.all, so Redis's rejection has to be covered
	// separately — MongoDB resolving is not enough to prove the catch handles either side.
	it('reports to Sentry and disconnects with code 1 when Redis fails to connect', async () => {
		const error = new Error('redis boom')
		RedisConnect.mockRejectedValueOnce(error)

		await start()

		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})

	// ⚠️ The boot failure that protects the data. setupFieldEncryption() throws when
	// CSFLE_MASTER_KEY_PATH names nothing readable, and the service must die there rather than serve:
	// a process that got past this point would read binData it cannot decrypt and write plaintext
	// into collections whose other documents are ciphertext, silently, until someone reads it back.
	it('reports to Sentry and disconnects with code 1 when field encryption cannot start', async () => {
		const error = new Error('CSFLE_MASTER_KEY_PATH is not set — field encryption cannot start without it')
		setupFieldEncryption.mockRejectedValueOnce(error)

		await start()

		expect(setupFieldEncryption).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		// ⚠️ And the retention scrub is NOT armed. It is the one background job in this process that
		// overwrites personal data, and it must never run on a connection whose encryption failed to
		// start: an unencrypted sweep would write readable placeholders into `binData` paths.
		expect(startRetentionSweeper).not.toHaveBeenCalled()
	})

	// Unique to the resource tier: uploads are scanned, so a missing clamd is a boot failure and
	// not something to discover on the first upload.
	it('reports to Sentry and disconnects with code 1 when ClamAV cannot be initialised', async () => {
		const error = new Error('no clamd socket')
		initClamScan.mockRejectedValueOnce(error)

		await start()

		expect(initClamScan).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})
})

describe('createServer (real Koa/Apollo assembly, no real datasource behind it)', () => {
	// createServer() never calls MongoDBConnect/RedisConnect/initClamScan itself — start() does,
	// separately — so it can be driven directly over a real, ephemeral-port HTTP server with no
	// datasource behind it at all. The bearer gate is satisfied with the introspection code, the
	// same way test/integration/index.itest.mts satisfies it for /health; a real Redis session is
	// exercised at the handler level by authorizationAuthenticatedResourceHandler.test.mts instead.
	let httpServer: Awaited<ReturnType<typeof createServer>>['httpServer']
	let apolloServer: Awaited<ReturnType<typeof createServer>>['apolloServer']
	let base: string

	beforeEach(async () => {
		vi.mocked(ApolloServerPluginDrainHttpServer).mockClear()
		const server = await createServer()
		httpServer = server.httpServer
		apolloServer = server.apolloServer
		await new Promise<void>((resolve) => httpServer.listen(0, resolve))
		const address = httpServer.address() as AddressInfo
		base = `http://127.0.0.1:${address.port}`
	})

	afterEach(async () => {
		await apolloServer.stop()
		await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	})

	// Kills the ArrayDeclaration mutant on `plugins: [ApolloServerPluginDrainHttpServer(...)]` ->
	// `plugins: []`: with the mutant the factory is simply never called. Checked with the exact
	// httpServer instance createServer() just built (not just "called once") so a mutant that wired
	// the plugin to some other object would still be caught.
	it('wires ApolloServerPluginDrainHttpServer to the httpServer it just built', () => {
		expect(ApolloServerPluginDrainHttpServer).toHaveBeenCalledExactlyOnceWith({ httpServer })
	})

	// Proves apolloServerKoa's `context()` really hands the raw Koa `ctx` to resolvers, not the
	// integration's own `{}` default. The introspection-code bypass (used by every other test in
	// this block) deliberately skips setting ctx.state.user, so this is the one request here that
	// goes through the real bearer-token branch of authorizationAuthenticatedResourceHandler, with
	// Redis mocked at the hGetAll level (the same seam test/authorizationAuthenticatedResourceHandler
	// .test.mts uses) rather than a real cluster.
	it('wires the Koa ctx into the resolver context, so an authenticated query sees ctx.state.user', async () => {
		const OID = '507f1f77bcf86cd799439011'
		// `tier` is not decoration: the auth middleware refuses a session that does not carry
		// `admin`, so without it this whole assembly answers 403 instead of reaching the resolver.
		hGetAll
			.mockReset()
			.mockResolvedValueOnce(Object.assign(Object.create(null), { _id: OID, email: 'admin@marketplace.test', tier: 'admin' }))

		const res = await fetch(`${base}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer access:unit-test-token' },
			body: JSON.stringify({ query: '{ infoAdminAfterLogin { _id email } }' })
		})
		const json = (await res.json()) as { data?: { infoAdminAfterLogin: { _id: string; email: string } } }

		expect(res.status).toBe(200)
		expect(json.data?.infoAdminAfterLogin).toEqual({ _id: OID, email: 'admin@marketplace.test' })
	})

	// Apollo's CSRF prevention treats `application/x-www-form-urlencoded` / `text/plain` /
	// `multipart/form-data` as suspicious unless a non-empty `x-apollo-operation-name` (or
	// `apollo-require-preflight`) header is present. With `csrfPrevention: false` this request would
	// instead reach runHttpQuery and fail on a different, later check.
	it('blocks a form-encoded POST with no preflight header as a potential CSRF attempt (csrfPrevention: true)', async () => {
		const res = await fetch(`${base}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-introspectioncode': 'test-introspection-code' },
			body: 'query=' + encodeURIComponent('{ __typename }')
		})
		const json = (await res.json()) as { errors?: Array<{ message: string }> }

		expect(res.status).toBe(400)
		expect(json.errors?.[0]?.message).toContain('potential Cross-Site Request Forgery')
	})

	it('serves the assembled schema at ENDPOINT for an introspection-code caller', async () => {
		const res = await fetch(`${base}${ENDPOINT}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-introspectioncode': 'test-introspection-code' },
			body: JSON.stringify({ query: '{ __schema { queryType { name } mutationType { name } } }' })
		})
		const json = (await res.json()) as {
			data?: { __schema: { queryType: { name: string }; mutationType: { name: string } } }
		}

		expect(res.status).toBe(200)
		expect(json.data?.__schema).toEqual({ queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } })
	})

	it('serves /health once the bearer gate is satisfied', async () => {
		const res = await fetch(`${base}/health`, { headers: { 'x-introspectioncode': 'test-introspection-code' } })
		const json = (await res.json()) as { status: string; timestamp: string }

		expect(res.status).toBe(200)
		expect(json.status).toBe('OK')
	})

	it('falls through to 404 for an unknown path', async () => {
		const res = await fetch(`${base}/nope`, { headers: { 'x-introspectioncode': 'test-introspection-code' } })

		expect(res.status).toBe(404)
	})

	// No credential at all: the bearer gate runs before the ENDPOINT/health/else routing decision,
	// so every path answers the same 412 — including /health, which a routing-only test could miss.
	it('rejects a request that carries no bearer credential at all', async () => {
		const res = await fetch(`${base}/health`)
		const json = (await res.json()) as { message?: string }

		expect(res.status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})

	// Regression test for gracefulShutdown() itself: a real client left connected on a keep-alive
	// socket must not make shutdown hang. On this Node version (v24) http.Server#close() already
	// destroys idle keep-alive sockets on its own (httpServerPreClose -> closeIdleConnections,
	// verified directly by timing a bare close() against an open idle connection with no Apollo
	// plugin involved at all: ~1ms) — so this test cannot tell ApolloServerPluginDrainHttpServer's
	// presence from its absence, which is why the wiring is asserted separately and explicitly in
	// "wires ApolloServerPluginDrainHttpServer to the httpServer it just built" above instead.
	//
	// Races on httpServer's own 'close' event, NOT on gracefulShutdown()'s returned promise:
	// gracefulShutdown calls `httpServer.close(callback)` but does not await that callback before
	// returning, so racing its promise would resolve 'drained' immediately regardless of whether the
	// socket ever actually closed. 'close' only fires once every connection, including the idle
	// keep-alive one, has really ended.
	it('drains an idle keep-alive connection so gracefulShutdown does not stall', async () => {
		const agent = new http.Agent({ keepAlive: true })
		const port = (httpServer.address() as AddressInfo).port
		try {
			await new Promise<void>((resolve, reject) => {
				const req = http.request(
					{ hostname: '127.0.0.1', port, path: '/health', agent, headers: { 'x-introspectioncode': 'test-introspection-code' } },
					(res) => {
						res.resume()
						res.on('end', resolve)
						res.on('error', reject)
					}
				)
				req.on('error', reject)
				req.end()
			})

			const closed = new Promise<void>((resolve) => httpServer.once('close', resolve))
			const shutdown = gracefulShutdown('SIGTERM', apolloServer, httpServer)

			const timedOut = Symbol('timedOut')
			const outcome = await Promise.race([
				closed.then(() => 'drained' as const),
				new Promise((resolve) => setTimeout(() => resolve(timedOut), 2000))
			])

			expect(outcome).toBe('drained')
			await shutdown
		} finally {
			agent.destroy()
		}
	})
})

describe('start (success path)', () => {
	beforeEach(() => {
		armBootMocks()
		// Real listen() options, unlike the failure-path block above: this test actually binds a
		// socket, so PORT needs a value Node can listen on rather than the placeholder 'x'.
		vi.stubEnv('PORT', '0')
	})
	afterEach(() => vi.unstubAllEnvs())

	it('connects both datasources, arms ClamAV, boots the real server on the configured host and listens', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
		const listenSpy = vi.spyOn(net.Server.prototype, 'listen')

		const server = await start()

		expect(MongoDBConnect).toHaveBeenCalledTimes(1)
		expect(RedisConnect).toHaveBeenCalledTimes(1)
		expect(initClamScan).toHaveBeenCalledTimes(1)
		// Called with nothing: it takes the client off the mongoose connection MongoDBConnect just
		// opened, and both its variables from the environment. An argument here would mean a second
		// client and a second connection pool for the same cluster.
		expect(setupFieldEncryption).toHaveBeenCalledExactlyOnceWith()
		// ⚠️ ADR-041's erasure has no scheduler outside this process: if start() stops arming it, nothing
		// anywhere reports that day-30 scrubbing has stopped, and closed accounts keep their data for ever
		// while every deploy looks healthy. Called with nothing — it reads its own clock per sweep.
		expect(startRetentionSweeper).toHaveBeenCalledExactlyOnceWith()
		expect(server?.httpServer.listening).toBe(true)
		// Asserting the exact options object listen() receives — not just that the server ends up
		// listening — is what proves `{ port }` alone travelled through unmodified: a mutant that
		// re-adds a host key, drops port, or swaps in some other object would still leave Node able
		// to bind *something*, so `listening` alone could never tell those apart.
		expect(listenSpy).toHaveBeenCalledExactlyOnceWith({ port: '0' }, expect.any(Function))
		// No host key means Node binds the unspecified address (every interface, IPv6 form '::')
		// rather than a single one — this is what proves the wide bind is real, not just that some
		// address got picked.
		expect((server?.httpServer.address() as AddressInfo).address).toBe('::')
		// Exact string, not a substring match: this is logListening() called with zero arguments, the
		// same way start() really calls it — the path that shipped a "Serving http://undefined:..."
		// banner once HOSTNAME stopped being set anywhere, while a stringContaining(ENDPOINT) check
		// like this used to be would have stayed green through that regression.
		expect(info).toHaveBeenCalledExactlyOnceWith(`Serving http://*:0${ENDPOINT} for test.`)

		await server?.apolloServer.stop()
		await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()))
		info.mockRestore()
		listenSpy.mockRestore()
	})
})

// ⚠️ **`app.proxy` off is load-bearing, not an unset default nobody thought about.** With it off,
// `ctx.ip` is the socket address — nginx's own — so no client address is reachable in this process
// at all, which is the design: the per-caller rate limit is the edge's (`conf.d/20-rate-limit.conf`
// keys its zones on `$binary_remote_addr` after `real_ip_header CF-Connecting-IP`), and nothing here
// can write a visitor's address to Redis, to a log line or to Sentry. Turning it on would silently
// start trusting `X-Forwarded-For` and start producing real addresses everywhere `ctx.ip` is read.
// A comment cannot prevent that; this test can, and it is the reason the setting is never assigned.
describe('app.proxy', () => {
	it('is off on the constructed Koa app', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')

		const { app, apolloServer } = await createServer()

		expect(app.proxy).toBeFalsy()

		await apolloServer.stop()
		vi.unstubAllEnvs()
	})
})

/*
 * ⚠️ The boot itself, not just `checkRequiredEnv`. The check runs OUTSIDE `start()`'s try, so a missing
 * variable has to travel out of `start()` to the caller instead of being swallowed into the
 * disconnect-and-exit that handles a datasource failure — and it must get there before anything has
 * connected, because a datasource handle left half-open by a boot nobody completed is a connection
 * the pool goes on holding.
 */
describe('start (missing environment)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('rejects — with no datasource touched — when a required variable is missing', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		vi.stubEnv('REDIS_KEY', '')
		RedisConnect.mockClear()
		disconnectAllDatabases.mockClear()

		await expect(start()).rejects.toThrow('Internal Server Error')
		expect(RedisConnect).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()
	})
})
