import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funImprenditoreUpdateEmail } from '@lib/imprenditore/funImprenditoreUpdateEmail.mjs'
import { emailObbligatoria } from '@lib/validate/campi.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	email: string
}

/**
 * Changes `login.email` — the credential, not `anagrafica.contatti.email`.
 *
 * Separate from `imprenditoreUpdate` because it is the only field on the collection with a unique
 * index behind it, so it is the only one whose save can fail for a reason the operator can fix. Bundled
 * into the anagrafica write, a collision would have rolled back an otherwise valid page of edits.
 */
export const imprenditoreUpdateEmail = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: "aggiorna l'email di login dell'imprenditore",
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		email: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funImprenditoreUpdateEmail(args._id, emailObbligatoria(args.email, 'email'))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
