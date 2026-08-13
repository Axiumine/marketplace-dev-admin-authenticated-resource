import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { Tier } from '@axiumine/marketplace-common/others/Tier'
import { funReuseEvents } from '@lib/session/funReuseEvents.mjs'
import { GraphQLReuseEvent } from '@ptypes/GraphQLReuseEvent.mjs'
import { GraphQLTier } from '@ptypes/GraphQLTier.mjs'
import { GraphQLError, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'

export const reuseEvents = {
	description: 'Read the trail of lineages this account has had revoked, newest first',
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLReuseEvent))),
	/*
	 * ⚠️ **The same two arguments `sessions` takes, and for the same reason**: the trail is filed per
	 * account under `${REDIS_KEY}reuse:<tier>:<accountId>`, so both halves name it and neither is a filter.
	 *
	 * ⚠️ **No count argument.** The trail is bounded to fifty by the trim on every append, and a `limit`
	 * would be a knob over a list that is already short — while inviting the platform-wide read that E17's
	 * open question 3 ruled out. What an operator reads is the whole trail or nothing.
	 */
	args: {
		tier: { type: new GraphQLNonNull(GraphQLTier) },
		accountId: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: { tier: Tier; accountId: string }) {
		try {
			return await funReuseEvents(args.tier, args.accountId)
		} catch (e) {
			return tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
