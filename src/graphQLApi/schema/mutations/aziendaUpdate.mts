import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { GraphQLInputAzienda } from '@GraphQLInput/GraphQLInputAzienda.mjs'
import { funAziendaUpdate } from '@lib/azienda/funAziendaUpdate.mjs'
import { IAziendaInput, validaAzienda } from '@lib/validate/validaAzienda.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	azienda: IAziendaInput
}

/**
 * Rewrites one company's data.
 *
 * Same input object as `aziendaAdd`, minus the owner: `idImprenditore` is not an argument here and is not
 * in `GraphQLInputAzienda` either, so editing a card cannot move the company to another imprenditore.
 * That is not an omission to be filled in later — a company's shops are the owner's, and reassigning it
 * would silently hand them over with it.
 *
 * The whole object in one `$set`, for the reason the shop mutations give: it is one form and one Save, on
 * a single document, so the write is atomic and a rejected PEC cannot leave the new ragione sociale
 * already stored.
 */
export const aziendaUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'aggiorna un’azienda',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		azienda: { type: new GraphQLNonNull(GraphQLInputAzienda) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funAziendaUpdate(args._id, validaAzienda(args.azienda))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
