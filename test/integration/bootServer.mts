import type { AddressInfo } from 'node:net'

import type { Server } from 'http'

import { start } from '../../src/index.mts'

/**
 * The boot both long-running integration suites open with.
 *
 * `start()` is the real entry point against the real Redis cluster, MongoDB and clamd, so the two things
 * that can go wrong before a request is ever sent are worth failing loudly on: it returns nothing when a
 * datasource refused, and the listening socket is asked for its port rather than told one, because the
 * suites bind port 0 and let the kernel choose.
 *
 * Not a `*.itest.mts` file on purpose: the integration project collects `test/integration/*.itest.mts`, so
 * this sits beside the suites without becoming one.
 */
export async function bootServer(): Promise<{ base: string; httpServer: Server }> {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB / clamd')
	const { httpServer } = server
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')

	return { base: `http://127.0.0.1:${address.port}`, httpServer }
}
