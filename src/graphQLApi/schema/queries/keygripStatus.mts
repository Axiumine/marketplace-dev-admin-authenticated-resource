import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funKeygripStatus } from '@lib/keygrip/funKeygripStatus.mjs'
import { GraphQLKeygripStatus } from '@ptypes/GraphQLKeygripStatus.mjs'
import { GraphQLError, GraphQLNonNull } from 'graphql'

export const keygripStatus = {
	description: 'Get the current cookie-signing key set and which services are holding it',
	type: new GraphQLNonNull(GraphQLKeygripStatus),
	/*
	 * ⚠️ No arguments, and no way to name a version. This reads the record that is live right now; a
	 * `version` argument would be a request to unwrap an *older* blob, and the platform keeps none — the
	 * rotation replaces all three fields at once. There is nothing older to ask for, and inventing an
	 * argument for it would be inventing a reason to keep one.
	 */
	args: {},
	async resolve() {
		try {
			return await funKeygripStatus()
		} catch (e) {
			return tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
