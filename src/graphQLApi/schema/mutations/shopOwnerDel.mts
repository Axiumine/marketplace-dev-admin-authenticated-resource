import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEveryShopOwnerSession } from '@lib/auth/endEveryShopOwnerSession.mjs'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funShopOwnerDelete } from '@lib/shopOwner/funShopOwnerDelete.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Closes a shop owner's account on the admin's authority.
 *
 * ⚠️ **The admin's id is recorded, and it comes off `ctx.state.user`** (ADR-044). `deletedBy` beside a
 * `deleted` stamp is what distinguishes an account the platform closed from one its holder closed — the
 * absence of the field *is* the self-service case — so a closure that did not name its actor would erase
 * exactly the distinction the kept document exists to carry.
 *
 * ⚠️ **Closing ends every session the owner holds**, for the reason `shopOwnerUpdateStatus` documents at
 * length: until this line the stamp is a label. `checkUserAuthorizationDisDel` refuses a closed account at
 * the login gate and `findAccountForSession` re-runs that on every refresh, but neither bites until the
 * next rotation, so a closed owner kept working for a whole access-token lifetime. There is no releasing
 * counterpart to compare against here — a closure has no "off" — so the revoke is unconditional.
 *
 * The revoke runs after the write and only if it succeeded: `funShopOwnerDelete` answers 404 when nothing
 * matched, and an id that names no open account has no sessions to end.
 */
export const shopOwnerDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'deletes a shopOwner',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextAdminAuthenticatedResource) {
		try {
			await funShopOwnerDelete(args._id, ctx.state.user._id)
			await endEveryShopOwnerSession(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
