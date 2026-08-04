import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funImprenditoreUpdate } from '@lib/imprenditore/funImprenditoreUpdate.mjs'
import { IAnagraficaImprenditoreInput, validaAnagraficaImprenditore } from '@lib/validate/validaAnagraficaImprenditore.mjs'
import { GraphQLInputAnagraficaImprenditore } from '@thedoctorweb_agency/marketplace-common/schema/GraphQLInput/GraphQLInputAnagraficaImprenditore'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	anagrafica: IAnagraficaImprenditoreInput
}

export const imprenditoreUpdate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'aggiorna imprenditore',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		anagrafica: { type: new GraphQLNonNull(GraphQLInputAnagraficaImprenditore) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			// Validated *and normalised* before the write, never after: the returned object is what
			// reaches `$set`, trimmed and with a cleared `fisso` removed rather than sent as null. The
			// call sits inside the try because `throwErrorWrongUserInput` raises a GraphQLError and
			// tryCatchRethrow passes those through with their own 400 status, un-Sentried — only a
			// genuine bug in the validator would come out of here as a 500.
			await funImprenditoreUpdate(args._id, validaAnagraficaImprenditore(args.anagrafica, new Date()))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
