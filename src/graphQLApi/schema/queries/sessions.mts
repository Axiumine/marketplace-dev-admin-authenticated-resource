import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { Tier } from '@axiumine/marketplace-common/others/Tier'
import { funSessions } from '@lib/session/funSessions.mjs'
import { GraphQLSession } from '@ptypes/GraphQLSession.mjs'
import { GraphQLTier } from '@ptypes/GraphQLTier.mjs'
import { GraphQLError, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'

export const sessions = {
	description: 'List the live sessions one account holds',
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLSession))),
	/*
	 * ⚠️ **Both halves of the account, always.** Ids come from three separate collections and nothing stops
	 * two of them minting the same `ObjectId` string, so a query by id alone could list — and then end — a
	 * stranger's sessions. The tier is a segment of the index key, not a filter applied afterwards.
	 *
	 * ⚠️ **No pagination and no "all accounts" form.** E17's open question 3 was answered "per account
	 * only": a platform-wide list needs a second index and puts the console back on a keyspace scan
	 * (BCON-08). One account's sessions are one hash, and a hash that grew past what a screen can hold is
	 * an incident in itself rather than a paging problem.
	 */
	args: {
		tier: { type: new GraphQLNonNull(GraphQLTier) },
		accountId: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: { tier: Tier; accountId: string }) {
		try {
			return await funSessions(args.tier, args.accountId)
		} catch (e) {
			return tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
