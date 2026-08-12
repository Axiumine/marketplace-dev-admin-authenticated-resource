import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { GraphQLShopOwnerById } from '@ptypes/GraphQLShopOwnerById.mjs'
import { GraphQLID, GraphQLNonNull } from 'graphql'
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
		return (
			ShopOwner.findById({
				_id: args.idShopOwner
			})
				// ⚠️ Every name here has to be a real path on ShopOwner, and nothing tells you when one is
				// not: Mongoose drops an unknown token from a projection string silently, so the field
				// simply never loads and the GraphQL type answers `null` for it — a bug that looks exactly
				// like an empty value. `note` sat here for a while in place of `notes`, which is why the
				// operator note read as blank in the admin UI for every shop owner who had one.
				.select(
					'_id login.email login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone login.rememberMe ' +
						'registeredAt personalData waitApprov notes resetPwd disabled deleted'
				)
				.lean()
		)
	}
}
