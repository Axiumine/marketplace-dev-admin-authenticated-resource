import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputShopOwnerPersonalData } from '@axiumine/marketplace-common/schema/GraphQLInput/GraphQLInputShopOwnerPersonalData'
import { funShopOwnerUpdate } from '@lib/shopOwner/funShopOwnerUpdate.mjs'
import { IShopOwnerPersonalDataInput, validateShopOwnerPersonalData } from '@lib/validate/validateShopOwnerPersonalData.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	personalData: IShopOwnerPersonalDataInput
}

export const shopOwnerUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates a shopOwner',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		personalData: { type: new GraphQLNonNull(GraphQLInputShopOwnerPersonalData) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			// Validated *and normalised* before the write, never after: the returned object is what
			// reaches `$set`, trimmed and with a cleared `landline` removed rather than sent as null. The
			// call sits inside the try because `throwErrorWrongUserInput` raises a GraphQLError and
			// tryCatchRethrow passes those through with their own 400 status, un-Sentried — only a
			// genuine bug in the validator would come out of here as a 500.
			await funShopOwnerUpdate(args._id, validateShopOwnerPersonalData(args.personalData, new Date()))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
