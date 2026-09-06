import { ApolloServer } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { koaMiddleware as apolloServerKoa } from '@as-integrations/koa'
import { MongoDBConnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { initClamScan } from '@axiumine/koa-utils/files/scanVirus'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { tdwKoaErrorHandler } from '@axiumine/koa-utils/koa/tdwKoaErrorHandler'
import { setupFieldEncryption } from '@axiumine/marketplace-common/encryption/setupFieldEncryption'
import type { EnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import { assertEnvShape } from '@axiumine/marketplace-common/others/assertEnvShape'
import { assertRedisNamespace } from '@axiumine/marketplace-common/others/assertRedisNamespace'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { reportClamSignatureAge } from '@lib/clam/reportClamSignatureAge.mjs'
import { authorizationAuthenticatedResourceHandler } from '@lib/db/authorizationAuthenticatedResourceHandler.mjs'
import { disconnectAllDatabases } from '@lib/db/disconnectAllDatabases.mjs'
import { startRetentionSweeper } from '@lib/retention/startRetentionSweeper.mjs'
import * as Sentry from '@sentry/node'
import { GraphQLSchema, NoSchemaIntrospectionCustomRule, ValidationRule } from 'graphql'
import depthLimit from 'graphql-depth-limit'
import graphqlUploadKoa from 'graphql-upload/graphqlUploadKoa.mjs'
import http from 'http'
import Koa, { Context, Next } from 'koa'
import bodyParserKoa from 'koa-bodyparser'

import MutationsPublic from './graphQLApi/schema/mutations.mjs'
import QueriesPublic from './graphQLApi/schema/queries.mjs'

export const ENDPOINT = '/admin-authenticated-resource'

// `DSN` is deliberately NOT in this list. Sentry is optional: `Sentry.init({ dsn: undefined })` is a
// no-op, so a missing telemetry credential must never stop the service from serving. Requiring it made
// boot fail *silently* — checkRequiredEnv() runs outside start()'s try, so the throw reached only the
// top-level `.catch`, which reports to the very Sentry client the missing DSN had just disabled.
export const REQUIRED_ENV_VARS = [
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
	// ADR-029. Both are read by setupFieldEncryption() below, and both belong in this list rather
	// than being left to fail later: a service that boots without them cannot read a single personal
	// field, and every query that touches one throws on its first use instead of at startup.
	'CSFLE_MASTER_KEY_PATH',
	'CSFLE_KEY_VAULT_NAMESPACE',
	// ⚠️ `SOCKETLABS_SERVER_ID` and `SOCKETLABS_SERVER_APIKEY` are deliberately NOT here. Only
	// `SocketLabsLib` reads them, this service imports no part of it, and every mail the platform sends
	// is sent by `public-resource` — so the pair was a mail credential required at boot by a service that
	// cannot send mail; the dependency itself left `package.json` in the same commit.
	//
	// ⚠️ Six more left this list for the same reason. `EMAIL_FROM`, `PLATFORM_NAME` and
	// `DEV_TEAM_EMAIL` are read only by `SocketLabsLib` — the first two in its constructor, the third in
	// `alertDevTeam()` and `sendEmailPostReported()`, which no service on this platform calls. And
	// `SAMESITE_COOKIE`, `HIT_STATS` and `REDIRECT_DOMAIN` are read by nothing anywhere: no `src/` file in
	// any of the nine services, no `dist/` in either `@axiumine` package.
	// `SAMESITE_COOKIE` is the one that looks load-bearing and is not — the cookie policy it appears to
	// name is the literal `sameSite: 'Strict'` in `@axiumine/koa-utils/dist/lib/tokenOptions.mjs`, which
	// reads no variable, and the edge's `Secure` rewrite (ADR-034) is nginx config. A variable required at
	// boot and read by nothing teaches admins that this list is noise, which is the one thing it cannot
	// afford to be.
	// ADR-034. This service signs no cookie and never will; it holds the key that opens the
	// record the five signing services read, because `keygripRotate` is where the platform's signing keys
	// are minted and resealed. Required at boot rather than checked at first use: an admin reaching
	// for rotation is usually doing it during an incident, and "this service was never given the KEK" is
	// not an answer anybody wants at that moment. A KEK that is present but *wrong* cannot be caught
	// here — nothing reads the record until a rotation runs — and the rotation refuses rather than
	// writing a record its siblings cannot open.
	'KEYGRIP_KEK'
]

/**
 * The *kind* of value each name must hold, checked by `assertEnvShape` after the presence loop above.
 * Presence and shape are two passes on purpose: a name may be shaped without being required, which is
 * what lets `REDIS_URL` appear here and in no list.
 *
 * ⚠️ **A name absent from this map is unconstrained, and several are deliberately absent.**
 * `REDIS_USERNAME` and `REDIS_PASSWORD` are free strings — a credential has no format, and a rule
 * invented for one would refuse a legal password. `KEYGRIP_KEK` is left out because its length rule
 * belongs to `readKek`, the single decode site: a second spelling of it here is the drift that comment
 * exists to prevent.
 *
 * What this catches is an environment filled in from somewhere else — a Mongo URI in the Redis slot,
 * `true` where koa-utils compares against `'1'`, a host name carrying a scheme, a port with a typo in
 * it. All four are truthy, so the loop above passes every one of them. A plausible wrong value of the
 * right shape still passes and always will, because no check this process runs knows what the rest of
 * the fleet was pointed at: that residual is the open half of `RISK_REGISTER` R04.
 */
export const ENV_SHAPES: Readonly<Record<string, EnvShape>> = {
	PORT: 'port',
	REDIS_IS_CLUSTER: 'flag01',
	/*
	 * ⚠️ Shaped here and required nowhere. Its presence rule is the conditional at the foot of
	 * `checkRequiredEnv`, because the cluster branch never reads it and the committed `env` template ships
	 * it empty — a shape pass that also demanded presence would refuse the very machines this workspace
	 * ships configured. `assertEnvShape` skips an absent or empty value for exactly this case.
	 */
	REDIS_URL: 'redisUrl',
	REDIS_DB1_HOST: 'hostname',
	REDIS_DB2_HOST: 'hostname',
	REDIS_DB3_HOST: 'hostname',
	REDIS_DB1_PORT: 'port',
	REDIS_DB2_PORT: 'port',
	REDIS_DB3_PORT: 'port',
	REDIS_KEY: 'keyPrefix',
	MONGODB_URI: 'mongoUri',
	CSFLE_MASTER_KEY_PATH: 'absolutePath',
	CSFLE_KEY_VAULT_NAMESPACE: 'namespace'
}

/**
 * Fail fast if any required environment variable is missing.
 *
 * Unlike the authorization services this raises through throwInternalError(), i.e. a GraphQLError
 * carrying a 500 — the missing variable name travels in `extensions.description`, never in the
 * client-facing message. Behaviour kept as it was; only the loop moved out of start().
 */
export function checkRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const envVar of REQUIRED_ENV_VARS) {
		if (!env[envVar]) {
			// await adminLog(mex, LogLevel.fatal)
			throwInternalError(`Missing required environment variable: ${envVar}`)
		}
	}

	/*
	 * ⚠️ **`REDIS_URL` is required on the single-node branch and on that branch only**, which is why it is checked
	 * here instead of being listed above. `REDIS_IS_CLUSTER=1` builds the cluster client out of the three
	 * `REDIS_DB*` pairs and never reads it — the committed `env` template ships it empty for exactly that reason,
	 * so a flat entry in the list would refuse the boot of a machine that is configured correctly.
	 *
	 * Any other value takes the `createClient({ url: resolveRedisUrl(REDIS_URL) })` branch, where node-redis
	 * answers an unset url with its own default of `redis://localhost:6379`. Empty is not an error there: the
	 * service connects to whatever happens to listen on this machine, writes every session into it and reports
	 * itself healthy, which is a wrong-but-populated environment nothing downstream can tell from a right one
	 * (`RISK_REGISTER` R04). `SETUP.md` puts a fresh machine on precisely that branch.
	 */
	if (env.REDIS_IS_CLUSTER !== '1' && !env.REDIS_URL) throwInternalError('Missing required environment variable: REDIS_URL')

	/*
	 * Shape last, and only once every name that must be present is. A value that is absent is a
	 * different fault from a value that is the wrong kind of thing, and reporting the second while the
	 * first is outstanding sends an admin to fix a variable they have not written yet.
	 *
	 * ⚠️ Rethrown through `throwInternalError()` for the reason the loop above raises that way, and a
	 * bare `throw` here would be the one environment fault in this service that does not: the
	 * client-facing message stays generic and the offending names travel in `extensions.description`.
	 * `assertEnvShape` names variables and never values, so the description carries names only.
	 */
	try {
		assertEnvShape(ENV_SHAPES, env)
	} catch (error) {
		throwInternalError((error as Error).message)
	}
}

/**
 * Production hardens the schema: no introspection and a query-depth cap.
 * Everywhere else the rules are empty so the playground/tooling stays usable.
 */
export function buildValidationRules(env: NodeJS.ProcessEnv = process.env): ValidationRule[] {
	return env.NODE_ENV === 'production' ? [NoSchemaIntrospectionCustomRule, depthLimit(10)] : []
}

/**
 * Body of the /health endpoint. Kept pure so it is trivially testable — it cannot
 * throw, which is why the old try/catch around it was removed as dead code.
 */
export function healthResponse(): { status: string; timestamp: string } {
	return { status: 'OK', timestamp: new Date().toISOString() }
}

/**
 * Log the listening banner; in production also mirror it to Sentry as an info event.
 */
export function logListening(env: NodeJS.ProcessEnv = process.env): void {
	const message = `Serving http://*:${env.PORT}${ENDPOINT} for ${env.NODE_ENV}.`
	if (env.NODE_ENV === 'production') Sentry.captureMessage(message, 'info')
	console.info(message)
}

/**
 * Drain Apollo, close the HTTP server, then disconnect the datasources and exit.
 */
export const gracefulShutdown = async (signal: string, apolloServer: ApolloServer, httpServer: http.Server) => {
	Sentry.captureMessage(`${signal} received, shutting down gracefully...`)
	await apolloServer.stop()
	httpServer.close(() => disconnectAllDatabases(0))
}

/**
 * Reported, but NOT fatal: this service keeps running after an unhandled rejection, unlike the
 * authorization services which exit(1). Left as-is on purpose — an upload that rejects late must
 * not take the whole resource server down.
 */
export function onUnhandledRejection(reason: unknown): void {
	Sentry.captureException(reason)
}

export function onUncaughtException(error: unknown): void {
	Sentry.captureException(error)
	process.exit(1)
}

/**
 * Build the Koa app + Apollo + HTTP server and start Apollo, WITHOUT connecting the
 * datasources or listening. Returned handles let callers (and tests) drive the server.
 */
export async function createServer() {
	/****************
	 * KOA
	 */
	const app = new Koa()
	// app.use(logger()) // useful only for log time to console
	app.use(tdwKoaErrorHandler)
	//app.use(debugHandler())

	// No cookie signing keys here: this tier authenticates with the `Authorization: Bearer access:`
	// header against Redis. The refresh cookie is minted and read by the authorization services.
	app.use(async (ctx: IContextAdminAuthenticatedResource, next: Next) => {
		await authorizationAuthenticatedResourceHandler()(ctx, next)
	})

	// Add graphql upload middleware - make sure this comes before Apollo middleware
	// Stryker disable next-line ObjectLiteral: no query or mutation in this service's schema (queries.mts /
	// mutations.mts, checked directly) declares a GraphQLUpload argument, and graphqlUploadKoa's own source
	// (node_modules/graphql-upload/graphqlUploadKoa.mjs) only ever reads maxFileSize/maxFiles inside its
	// `ctx.request.is('multipart/form-data')` branch — every request this service actually serves is JSON,
	// so that branch is never taken and these limits can never produce an observable difference here.
	app.use(graphqlUploadKoa({ maxFileSize: 30000000, maxFiles: 10 })) // 30MB limit, max 10 files

	// also needed by Apollo (koaMiddleware() 500s if ctx.request.body is never set).
	//
	// No options: koa-bodyparser's own defaults are `enableTypes: ['json', 'form']` and
	// `application/json` is already in its default json content-type list, so the explicit config
	// this used to carry — adding 'text' and re-declaring 'application/json' — changed nothing.
	// 'text' in particular can never matter here: co-body's text parser always returns a raw string,
	// and @apollo/server's runHttpQuery rejects any POST body that isn't a plain object
	// (isNonEmptyStringRecord), so a text/plain body fails identically whether or not 'text' parsing
	// is enabled (verified by reading node_modules/@apollo/server/dist/esm/runHttpQuery.js and
	// node_modules/co-body/lib/text.js directly, and by observing the same "POST body missing,
	// invalid Content-Type, or JSON object has no keys." response either way).
	app.use(bodyParserKoa())

	/****************
	 * KOA ENDPOINT
	 */
	app.use(async (ctx: Context, next: Next) => {
		if (ctx.path === ENDPOINT) {
			// @ts-expect-error TS2769: No overload matches this call.
			const middleware = apolloServerKoa(apolloServer, {
				async context() {
					return ctx
				}
			})
			return middleware(ctx, next)
		} else if (ctx.path === '/health') {
			ctx.body = healthResponse()
			ctx.status = 200
			return
		}
		// No final `else { await next() }`: this is the last app.use() in the stack (nothing is
		// registered after this middleware below, and the file has no other app.use() call) —
		// checked directly above. Calling next() here would only resolve Koa's own no-op "end of
		// the middleware chain" promise, so it cannot change ctx.status or ctx.body on any reachable
		// path — there is no downstream middleware left to run that could set them, and neither
		// branch above sets them either. That made the block an unkillable BlockStatement mutant
		// (`{ await next() } -> {}`) under Stryker; deleting the dead call removes the mutant rather
		// than papering over it with a directive.
	})

	/****************
	 * APOLLO
	 */
	const httpServer = http.createServer(app.callback())

	const graphQLSchema = new GraphQLSchema({
		query: QueriesPublic,
		mutation: MutationsPublic
	})

	const apolloServer = new ApolloServer({
		schema: graphQLSchema,
		plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
		validationRules: buildValidationRules(),
		csrfPrevention: true
	})

	await apolloServer.start()

	return { app, httpServer, apolloServer }
}

/**
 * Full boot: validate env, connect the datasources, arm the antivirus, build the server
 * and listen. Returns the handles on success; on failure disconnects and exits.
 */
export async function start() {
	checkRequiredEnv()

	try {
		/****************
		 * DB
		 */
		await Promise.all([MongoDBConnect(), RedisConnect()])

		/****************
		 * Redis namespace (ADR-034)
		 *
		 * The first thing asked of the connection, because `REDIS_KEY` is a prefix and there is no wrong value
		 * Redis itself refuses. This service reads the sessions the signing tier writes, so a prefix naming a
		 * namespace nobody seeded used to cost it nothing at boot: every lookup missed, every request was
		 * answered 401, and the service reported itself healthy while doing it. The five services that call
		 * `loadKeygrip` already fail here; this is the same refusal for a tier that reads no key material.
		 *
		 * Presence only — unwrapping the record is `readKeygrip`'s business, on behalf of the services that
		 * sign. It cannot see a fleet-wide wrong prefix, which is `RISK_REGISTER` R04 and is not a question a
		 * service can ask about itself.
		 */
		await assertRedisNamespace(redisClient)

		/****************
		 * Field encryption (ADR-029)
		 *
		 * After MongoDBConnect() and before anything can query: it reuses the connection mongoose has
		 * just opened, and the four models refuse to read or write a personal field until it has run.
		 * It throws rather than warning if the master key is missing — a service that started without
		 * it would write plaintext into collections whose other documents are ciphertext, and nothing
		 * would show that up until someone read the data back.
		 */
		await setupFieldEncryption()

		/****************
		 * Antivirus
		 *
		 * ⚠️ `initClamScan()` proves the daemon is reachable and says nothing about what it knows: a scanner
		 * whose signature database stopped updating six months ago answers `clean` just as fast. Nothing on
		 * this platform runs `freshclam`, so the age is read here and reported — never thrown on, because a
		 * stale scanner is worse than a fresh one and far better than refusing to serve at all.
		 */
		const clam = await initClamScan()

		await reportClamSignatureAge(clam)

		/****************
		 * Retention scrub (ADR-041)
		 *
		 * After setupFieldEncryption() and before the port opens: the sweep writes `personalData` on both
		 * account collections, so it needs the same encryption the resolvers do, and it must not be able to
		 * run against a connection that has none. Nothing is awaited beyond arming it — the first pass runs
		 * in the background and reports itself.
		 *
		 * This service and no other. It is the admin surface, it already writes both collections, and it
		 * is not the internet-facing unauthenticated one; a second service arming this would double-sweep,
		 * which the Redis lock survives but which nobody would be able to read in the logs.
		 */
		startRetentionSweeper()

		const { httpServer, apolloServer } = await createServer()

		/****************
		 * START SERVER
		 */
		await new Promise<void>((resolve) => {
			httpServer.listen(
				{
					port: process.env.PORT
					// No host: bind every interface on purpose. This used to pass a hostname key, which is not
					// a net.Server.listen option — Node ignored it and bound the unspecified address anyway, so
					// HOSTNAME never had any effect. Binding wide is the intent; the dead key only hid it.
				},
				() => {
					logListening()
					resolve()
				}
			)
		})

		return { httpServer, apolloServer }
	} catch (error) {
		console.error('error', error)
		Sentry.captureException(error) // @fixme never fires!
		await disconnectAllDatabases(1)
	}
}

/* v8 ignore start -- entrypoint wiring: executes only as the real process, never under test (NODE_ENV=test) */
// Stryker disable all: same guard as the v8 ignore above, same reason. Both vitest.config.mts projects
// (unit AND integration) set NODE_ENV=test, so this condition is false in every test run this repo has —
// there is no reachable input, under any test config, on which a mutant inside this block could be
// observed to behave differently. Restored below the closing brace so the rest of the file stays mutated.
if (process.env.NODE_ENV !== 'test') {
	// Handle unhandled promise rejections / uncaught exceptions
	process.on('unhandledRejection', onUnhandledRejection)
	process.on('uncaughtException', onUncaughtException)

	start()
		.then((srv) => {
			if (srv) {
				// Handle termination signals once the server is up
				process.on('SIGTERM', () => gracefulShutdown('SIGTERM', srv.apolloServer, srv.httpServer))
				process.on('SIGINT', () => gracefulShutdown('SIGINT', srv.apolloServer, srv.httpServer))
			}
		})
		.catch((e: unknown) => {
			/*
			 * ⚠️ The exit code is the whole point, and it used to be **0**. `checkRequiredEnv()` throws
			 * outside `start()`'s own try, so a missing variable lands here rather than in the
			 * disconnect-and-exit inside it — and this handler ended with a Sentry call and nothing else.
			 * Node then ran out of work and left with a success code: a service that never bound its port
			 * reported a clean shutdown to Docker, to systemd and to any restart policy reading `$?`, so a
			 * boot that failed was indistinguishable from one that was asked to stop. Sentry cannot stand in
			 * for the code either — with no DSN configured the SDK discards the event, which is the state
			 * this platform boots in. Say it where the container's own logs are, then leave with 1.
			 */
			console.error('fatal: the service could not start', e)
			Sentry.captureException(e)
			process.exit(1)
		})
}
// Stryker restore all
/* v8 ignore stop */
