import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { Tier } from '@axiumine/marketplace-common/others/Tier'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funRevokeSession } from '@lib/session/funRevokeSession.mjs'
import { GraphQLTier } from '@ptypes/GraphQLTier.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

export const revokeSession = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'ends one session of one account and stops it being listed',
	/*
	 * ⚠️ **Three arguments, and `id` is a session index field — never a token.** It is the digest the
	 * `sessions` query rendered, and it authenticates nothing: it names a Redis key and a hash field of an
	 * account the caller has already named. Why publishing a digest and taking it back are both safe is
	 * written out on `ISessionRow`, and turns on the `access:` / `refresh:` prefix every raw-token key
	 * carries and a bare index field does not.
	 *
	 * ⚠️ `Boolean!` answers *whether a live session was ended*, not whether the call succeeded — a row for a
	 * session that had already expired answers `false` and still prunes the index. The console must say
	 * "already ended" on `false`, because reporting it as an error would train an admin to retry a call
	 * that has already done everything it can.
	 */
	args: {
		tier: { type: new GraphQLNonNull(GraphQLTier) },
		accountId: { type: new GraphQLNonNull(GraphQLString) },
		id: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: { tier: Tier; accountId: string; id: string }, ctx: IContextAdminAuthenticatedResource) {
		try {
			// The admin's id meters the rate limit and travels nowhere else — never into the event trail,
			// which E17's open question 4 answered "not attributable".
			return await funRevokeSession(ctx.state.user._id, args.tier, args.accountId, args.id)
		} catch (e) {
			return tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
