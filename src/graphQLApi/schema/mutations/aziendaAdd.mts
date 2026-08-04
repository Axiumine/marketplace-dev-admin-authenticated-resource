import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputAzienda } from '@GraphQLInput/GraphQLInputAzienda.mjs'
import { funAziendaAdd } from '@lib/azienda/funAziendaAdd.mjs'
import { IAziendaInput, validaAzienda } from '@lib/validate/validaAzienda.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	idImprenditore: Types.ObjectId
	azienda: IAziendaInput
}

/**
 * Creates one company under an imprenditore.
 *
 * The owner is an argument: the session belongs to an operator, so `ctx.state.user._id` names the
 * operator and not the imprenditore whose page is open. The lib checks the id before writing.
 *
 * It answers `Boolean!` like every other write on this tier: the detail page re-reads
 * `imprenditoreAziende` after a save and has no use for the new id.
 */
export const aziendaAdd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'aggiunge un’azienda a un imprenditore',
	args: {
		idImprenditore: { type: new GraphQLNonNull(GraphQLID) },
		azienda: { type: new GraphQLNonNull(GraphQLInputAzienda) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funAziendaAdd(args.idImprenditore, validaAzienda(args.azienda))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
