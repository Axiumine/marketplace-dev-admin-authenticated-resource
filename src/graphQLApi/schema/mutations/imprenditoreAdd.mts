import { GraphQLInputLogin } from '@axiumine/koa-utils/graphQL/schema/GraphQLInput/GraphQLInputLogin'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IAnagraficaImprenditoreInput, validaAnagraficaImprenditore } from '@lib/validate/validaAnagraficaImprenditore.mjs'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { IImprenditoreSchema } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IImprenditoreSchema'
import { GraphQLInputAnagraficaImprenditore } from '@thedoctorweb_agency/marketplace-common/schema/GraphQLInput/GraphQLInputAnagraficaImprenditore'
import { ILoginInput } from '@thedoctorweb_agency/marketplace-common/schema/interfaces/ILoginInput'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	login: ILoginInput
	anagrafica: IAnagraficaImprenditoreInput
}

export const imprenditoreAdd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'aggiunge imprenditore',
	args: {
		login: { type: new GraphQLNonNull(GraphQLInputLogin) },
		anagrafica: { type: new GraphQLNonNull(GraphQLInputAnagraficaImprenditore) }
	},
	async resolve(_: unknown, args: IArgs) {
		// `await`, not `return Imprenditore.create(doc)`: without it the promise escaped the try, so
		// the catch could never run, and the mutation answered with the Mongoose document instead of
		// the declared Boolean — which GraphQLBoolean refuses to serialize. Now it matches its
		// siblings (imprenditoreDel / imprenditoreUpdate): do the work, rethrow, return true.
		try {
			// Validated *and normalised* before the write, exactly like `imprenditoreUpdate` — the
			// returned object is what reaches `create`, trimmed, with a blank landline dropped rather
			// than sent as null, and with the address point given the `type: 'Point'` the client never
			// sends. Both mutations take the same shared input type, so a coordinates-only point can
			// arrive here too; without this call it would be stored verbatim and rejected by the
			// collection validator as a 500 with nothing to tell the operator.
			const doc: IImprenditoreSchema = {
				// Minted here, not by Mongoose. Every model in marketplace-common declares `_id` explicitly
				// and without a default, which switches off auto-generation — so `create()` on a
				// document that has none throws "document must have an _id before saving" and never
				// reaches MongoDB. Same line every other *Add resolver on this tier carries (aziendaAdd).
				_id: new Types.ObjectId(),
				login: args.login,
				anagrafica: validaAnagraficaImprenditore(args.anagrafica, new Date()),
				iscrizione: new Date()
			}

			await Imprenditore.create(doc)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
