import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
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
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
