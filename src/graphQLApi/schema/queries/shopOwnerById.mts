import { GraphQLShopOwnerById } from '@ptypes/GraphQLShopOwnerById.mjs'
import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
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
		return ShopOwner.findById({
			_id: args.idShopOwner
		})
			.select(
				'_id login.email login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone login.rememberMe ' +
					'registeredAt personalData registeredAt waitApprov note resetPwd disabled deleted'
			)
			.lean()
	}
}
