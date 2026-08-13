import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { Tier } from '@axiumine/marketplace-common/others/Tier'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funRevokeAllSessions } from '@lib/session/funRevokeAllSessions.mjs'
import { GraphQLTier } from '@ptypes/GraphQLTier.mjs'
import { GraphQLError, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'

export const revokeAllSessions = {
	type: new GraphQLNonNull(GraphQLInt),
	description: 'ends every session one account holds and answers how many there were',
	/*
	 * ⚠️ **The account, both halves, and nothing else.** There is no "every account" form and there will not
	 * be one: it would be a single call that logs out the whole platform, and no incident this console is
	 * for is answered by it. The blast radius of this mutation is one account, by construction.
	 *
	 * ⚠️ `Int!` is the count actually revoked, which is what the console reports back. It is never larger
	 * than what happened: E15-S04's routine counts the sessions it deleted across every round, and on
	 * exhaustion it leaves the newcomers it did not reach out of the total rather than claiming them.
	 */
	args: {
		tier: { type: new GraphQLNonNull(GraphQLTier) },
		accountId: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: { tier: Tier; accountId: string }, ctx: IContextAdminAuthenticatedResource) {
		try {
			// The operator's id meters the rate limit and travels nowhere else — never into the event trail,
			// which E17's open question 4 answered "not attributable".
			return await funRevokeAllSessions(ctx.state.user._id, args.tier, args.accountId)
		} catch (e) {
			return tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
