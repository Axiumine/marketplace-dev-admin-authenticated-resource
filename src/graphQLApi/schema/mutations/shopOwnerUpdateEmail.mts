import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEveryShopOwnerSession } from '@lib/auth/endEveryShopOwnerSession.mjs'
import { funShopOwnerUpdateEmail } from '@lib/shopOwner/funShopOwnerUpdateEmail.mjs'
import { requiredEmail } from '@lib/validate/fields.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	email: string
}

/**
 * Changes `login.email` — the credential, not `personalData.contacts.email`.
 *
 * Separate from `shopOwnerUpdate` because it is the only field on the collection with a unique
 * index behind it, so it is the only one whose save can fail for a reason the operator can fix. Bundled
 * into the personalData write, a collision would have rolled back an otherwise valid page of edits.
 *
 * ⚠️ **`login.email` is a credential, so writing it ends the shop owner's sessions** (E15-S06). The
 * address is half of what they sign in with: after this mutation the old one no longer authenticates,
 * and a session minted against it has to stop working for the same reason a session minted against the
 * old password does. The operator's own session is untouched — theirs is not the account that changed.
 */
export const shopOwnerUpdateEmail = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates the login email of the shopOwner',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		email: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funShopOwnerUpdateEmail(args._id, requiredEmail(args.email, 'email'))

			// ⚠️ **After the write and inside the try, both deliberately** (E15-S06, the rule E15-S05 set).
			// Before it, an address that then collided with another account's would have logged a shop owner
			// out for a change that never happened. Outside it, a Redis that refused would leave this
			// answering `true` with sessions still live on an address that no longer signs in.
			await endEveryShopOwnerSession(args._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
