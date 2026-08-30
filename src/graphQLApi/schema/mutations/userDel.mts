import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEveryUserSession } from '@lib/auth/endEveryUserSession.mjs'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funUserDelete } from '@lib/user/funUserDelete.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
}

/**
 * Closes a customer's account on the admin's authority — the counterpart of `shopOwnerDel`, and until
 * this mutation the platform had one for sellers and none for customers: an admin could suspend a
 * customer but not close one, so an account that had to go took a hand-made production write on the one
 * collection encrypted whole.
 *
 * ⚠️ **The admin's id is recorded, and it comes off `ctx.state.user`** (ADR-044). `deletedBy` beside a
 * `deleted` stamp is what distinguishes an account the platform closed from one its holder closed — the
 * absence of the field *is* the self-service case — so a closure that did not name its actor would erase
 * exactly the distinction the kept document exists to carry.
 *
 * ⚠️ **Closing ends every session the customer holds**, for the reason `userUpdateStatus` documents at
 * length: until this line the stamp is a label. `checkUserAuthorizationDisDel` refuses a closed account at
 * the login gate and `findAccountForSession` re-runs that on every refresh, but neither bites until the
 * next rotation, so a closed customer kept shopping for a whole access-token lifetime. Unlike the status
 * mutation there is no "off" to compare against — a closure has one direction — so the revoke is
 * unconditional.
 *
 * The revoke runs after the write and only if it succeeded: `funUserDelete` answers 404 when nothing
 * matched, and an id that names no open account has no sessions to end.
 *
 * ⚠️ **This is not the erasure, and it is undoable for thirty days** (ADR-041, ADR-046). The personal
 * fields stay in the document, encrypted, until the day-30 scrub overwrites them in place, and the same
 * person registering again inside that window restores this very document on the same `_id`. What the
 * restore does *not* lift is a suspension — the `disabled*` trio comes back exactly as it was — so an
 * admin who closed a suspended customer has not handed them a way back in.
 */
export const userDel = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'deletes a user',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextAdminAuthenticatedResource) {
		try {
			await funUserDelete(args._id, ctx.state.user._id)
			await endEveryUserSession(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
