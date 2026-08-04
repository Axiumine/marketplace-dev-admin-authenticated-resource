import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funAdminUpdatePwd } from '@lib/admin/funAdminUpdatePwd.mjs'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

interface IArgs {
	passwordOld: string
	passwordNew: string
}

export const adminUpdatePwd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'aggiorna la password del proprio account admin',
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
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
