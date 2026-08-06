import { ApolloServer } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { koaMiddleware as apolloServerKoa } from '@as-integrations/koa'
import { MongoDBConnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { initClamScan } from '@axiumine/koa-utils/files/scanVirus'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { tdwKoaErrorHandler } from '@axiumine/koa-utils/koa/tdwKoaErrorHandler'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { authorizationAuthenticatedResourceHandler } from '@lib/db/authorizationAuthenticatedResourceHandler.mjs'
import { disconnectAllDatabases } from '@lib/db/disconnectAllDatabases.mjs'
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
	'SOCKETLABS_SERVER_ID',
	'SOCKETLABS_SERVER_APIKEY',
	'REDIRECT_DOMAIN',
	'EMAIL_FROM',
	'DEV_TEAM_EMAIL',
	'HIT_STATS',
	'INTROSPECTION_CODE',
	'PLATFORM_NAME',
	'SAMESITE_COOKIE'
]

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
		 * Antivirus
		 */
		await initClamScan()

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
		.catch((e) => {
			Sentry.captureException(e)
		})
}
// Stryker restore all
/* v8 ignore stop */
