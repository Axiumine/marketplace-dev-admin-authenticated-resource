import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEveryShopOwnerSession } from '@lib/auth/endEveryShopOwnerSession.mjs'
import { funShopOwnerUpdateStatus } from '@lib/shopOwner/funShopOwnerUpdateStatus.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	disabled: boolean
	waitApprov: boolean
}

/**
 * The disable switch and the manual-approval gate.
 *
 * Both arguments are `Boolean!`, not optional: the operator app sends the state of both toggles on
 * every save, so "not sent" would only ever mean a bug on the client. Nullable arguments here would
 * also make the mutation a partial update, and the one thing a partial update of these two cannot
 * express is turning a flag *off* — `null` for "leave alone" and `null` for "clear it" are the same
 * wire value.
 *
 * No validation call: `Boolean!` is the whole contract, and graphql-js has already enforced it by the
 * time this runs.
 *
 * ⚠️ **Both flags arrive on every save, so the revoke below reads the target state and never a
 * transition.** There is no "what was it before" to compare against and none is fetched: re-saving an
 * already-disabled account revokes again, which costs one `hKeys` over an index that is already empty.
 * Reading the previous state to avoid that would mean a second round trip on every save, and a gap
 * between the read and the write in which a login could slip through.
 */
export const shopOwnerUpdateStatus = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates the status of the shopOwner account',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		disabled: { type: new GraphQLNonNull(GraphQLBoolean) },
		waitApprov: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funShopOwnerUpdateStatus(args._id, args.disabled, args.waitApprov)

			// ⚠️ **Parking an account ends its sessions; releasing one does not** (E15-S07). Either flag
			// standing is a shop owner the platform has decided must not be signed in, and until this line
			// the status change was a label: `checkUserAuthorizationDisDel` and `checkShopOwnerApproval`
			// only bite at the next rotation, so a parked owner kept working for a whole refresh window.
			// The approve-and-enable transition deliberately revokes nothing — nobody's credentials
			// changed, and logging out an owner as a *reward* for being approved is not a control.
			if (args.disabled || args.waitApprov) await endEveryShopOwnerSession(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
