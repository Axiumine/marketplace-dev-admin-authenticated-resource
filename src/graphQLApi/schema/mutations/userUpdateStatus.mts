import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEveryUserSession } from '@lib/auth/endEveryUserSession.mjs'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funUserUpdateStatus } from '@lib/user/funUserUpdateStatus.mjs'
import { validateDisabledReason } from '@lib/validate/validateDisabledReason.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	disabled: boolean
	disabledReason?: string | null
}

/**
 * The disable switch on a customer account — and, until this mutation, the platform had none at all.
 * `user.disabled` was read by five paths across four services and written by nothing, so suspending a
 * customer meant a hand-made production write on the one collection encrypted whole.
 *
 * `disabled` is `Boolean!` rather than nullable, for the reason `shopOwnerUpdateStatus` documents: a
 * nullable flag makes this a partial update, and "leave it alone" and "clear it" are then the same wire
 * value — which makes turning the flag *off* inexpressible. There is no `waitApprov` argument and there
 * will not be one: the customer approval gate was closed permanently on 2026-08-25.
 *
 * ⚠️ **`disabledReason` is nullable because its requirement is conditional** — mandatory beside
 * `disabled: true`, meaningless beside `disabled: false` — and a GraphQL argument cannot say that.
 * `validateDisabledReason` carries the whole contract, identically to the seller tier: a 400 naming the
 * field when a suspension arrives without a reason, a 1000-character cap, and a silent drop when the
 * reason came alongside a release.
 *
 * ⚠️ **The admin's own id comes off `ctx.state.user`**, written by the Redis session lookup and not
 * reachable from the request body — ADR-044 exists so that a suspension names a real actor, and an
 * argument on the wire would let one admin sign another's name to it.
 *
 * ⚠️ **The argument is the target state, not a transition.** The admin app sends the state of the
 * toggle on every save, so re-disabling an already-disabled customer revokes again — one `hKeys` over an
 * index that is already empty. Reading the previous state to skip that would cost a round trip on every
 * save and open a window between the read and the write in which a login could slip through.
 */
export const userUpdateStatus = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates the status of the user account',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		disabled: { type: new GraphQLNonNull(GraphQLBoolean) },
		disabledReason: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IArgs, ctx: IContextAdminAuthenticatedResource) {
		try {
			await funUserUpdateStatus({
				_id: args._id,
				disabled: args.disabled,
				adminId: ctx.state.user._id,
				disabledReason: validateDisabledReason(args.disabled, args.disabledReason)
			})

			// ⚠️ **Disabling ends the customer's sessions; re-enabling ends nothing** — the same rule
			// `shopOwnerUpdateStatus` follows. Until this line the flag was a label: the three gates that read
			// it only bite at the next rotation, so a suspended customer kept shopping for a whole refresh
			// window. Re-enabling revokes deliberately
			// nothing — nobody's credentials changed, and signing a customer out as the consequence of being
			// re-enabled is not a control.
			if (args.disabled) await endEveryUserSession(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
