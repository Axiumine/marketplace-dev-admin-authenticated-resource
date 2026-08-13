import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funAdminUpdatePwd } from '@lib/admin/funAdminUpdatePwd.mjs'
import { endEverySession } from '@lib/auth/endEverySession.mjs'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

interface IArgs {
	passwordOld: string
	passwordNew: string
}

export const adminUpdatePwd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates the password of the signed-in admin account',
	// There is deliberately no `_id` argument. The account being changed is the one the request is
	// authenticated as, taken from the Redis session below — accepting an id from the client would
	// make this "change any operator's password", since every admin authenticates against the same
	// collection and the platform has no role field to check one against.
	args: {
		passwordOld: { type: new GraphQLNonNull(GraphQLString) },
		passwordNew: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextAdminAuthenticatedResource) {
		try {
			await funAdminUpdatePwd(ctx.state.user._id, args.passwordOld, args.passwordNew)

			// ⚠️ **After the write and inside the try, both deliberately** (E15-S05). Before it, a password
			// change that then failed validation would have logged the operator out of every device for
			// nothing. Outside it, a Redis that refused would leave this answering `true` with every stolen
			// session still live — which is the exact lie this story exists to stop telling. The caller's own
			// session goes too, so the next request they make is refused and they log in again.
			await endEverySession(ctx)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
