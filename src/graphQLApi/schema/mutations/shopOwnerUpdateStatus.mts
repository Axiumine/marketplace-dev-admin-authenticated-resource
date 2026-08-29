import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEveryShopOwnerSession } from '@lib/auth/endEveryShopOwnerSession.mjs'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funShopOwnerUpdateStatus } from '@lib/shopOwner/funShopOwnerUpdateStatus.mjs'
import { validateDisabledReason } from '@lib/validate/validateDisabledReason.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	disabled: boolean
	waitApprov: boolean
	disabledReason?: string | null
}

/**
 * The disable switch and the manual-approval gate.
 *
 * Both flags are `Boolean!`, not optional: the operator app sends the state of both toggles on
 * every save, so "not sent" would only ever mean a bug on the client. Nullable arguments here would
 * also make the mutation a partial update, and the one thing a partial update of these two cannot
 * express is turning a flag *off* — `null` for "leave alone" and `null` for "clear it" are the same
 * wire value.
 *
 * ⚠️ **`disabledReason` is the exception and is nullable on purpose.** Its requirement is conditional —
 * mandatory beside `disabled: true`, meaningless beside `disabled: false` — and graphql-js can express
 * "always" or "never", not "when that other argument is true". `validateDisabledReason` is therefore the
 * whole contract for this one argument: it raises a 400 naming the field when a suspension arrives
 * without a reason, caps the text at 1000 characters, and drops a reason that came with a release rather
 * than arguing with a form that kept its textarea populated.
 *
 * ⚠️ **The operator's own id comes off `ctx.state.user`, which the Redis session lookup writes and no
 * request can reach.** ADR-044's whole point is that a suspension names a real actor; an `adminBy`
 * argument on the wire would let any operator sign somebody else's name to their decision.
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
		waitApprov: { type: new GraphQLNonNull(GraphQLBoolean) },
		disabledReason: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextAdminAuthenticatedResource) {
		try {
			await funShopOwnerUpdateStatus({
				_id: args._id,
				disabled: args.disabled,
				waitApprov: args.waitApprov,
				adminId: ctx.state.user._id,
				disabledReason: validateDisabledReason(args.disabled, args.disabledReason)
			})

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
