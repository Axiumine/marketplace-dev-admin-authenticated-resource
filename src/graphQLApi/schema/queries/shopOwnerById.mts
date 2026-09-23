import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { GraphQLShopOwnerById } from '@ptypes/GraphQLShopOwnerById.mjs'
import { GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	idShopOwner: Types.ObjectId
}

export const shopOwnerById = {
	type: new GraphQLNonNull(GraphQLShopOwnerById),
	description: 'Get a shopOwner by id',
	args: {
		idShopOwner: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			const shopOwner = await ShopOwner.findById({
				_id: args.idShopOwner
			})
				// ⚠️ Every name here has to be a real path on ShopOwner, and nothing tells you when one is
				// not: Mongoose drops an unknown token from a projection string silently, so the field
				// simply never loads and the GraphQL type answers `null` for it — a bug that looks exactly
				// like an empty value. `note` sat here for a while in place of `notes`, which is why the
				// admin note read as blank in the admin UI for every shop owner who had one.
				//
				// ⚠️ `resetPwd.resetDateReq`, never the bare `resetPwd`: the sub-document also carries the
				// live, unencrypted reset token, and `GraphQLResetPwd` no longer declares a field for it —
				// projecting the whole sub-document would load it into memory for nothing.
				.select(
					'_id login.email login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone login.rememberMe ' +
						'registeredAt personalData waitApprov notes resetPwd.resetDateReq disabled disabledBy disabledReason deleted'
				)
				.lean()

			// The type is a NonNull: a stale or mistyped id must answer the platform's usual 404, not the
			// opaque "Cannot return null for non-nullable field" graphql-js raises on its own.
			if (shopOwner === null) throwNotFoundError('shopOwner not found')

			return shopOwner
		} catch (e) {
			return tryCatchRethrow(e as GraphQLError | Error)
		}
	}
}
