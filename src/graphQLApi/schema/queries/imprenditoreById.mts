import { GraphQLImprenditoreById } from '@ptypes/GraphQLImprenditoreById.mjs'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	idImprenditore: Types.ObjectId
}

export const imprenditoreById = {
	type: new GraphQLNonNull(GraphQLImprenditoreById),
	description: 'Get imprenditori per tabella',
	args: {
		idImprenditore: { type: new GraphQLNonNull(GraphQLID) }
	},
	async resolve(_: unknown, args: IArgs) {
		return Imprenditore.findById({
			_id: args.idImprenditore
		})
			.select(
				'_id login.email login.firstLogin login.lastLogin login.onboardingStep login.onboardingDone login.rememberMe ' +
					'iscrizione anagrafica iscrizione waitApprov note resetPwd disabled deleted'
			)
			.lean()
	}
}
