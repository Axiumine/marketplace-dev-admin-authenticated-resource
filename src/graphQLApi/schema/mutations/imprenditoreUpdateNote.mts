import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funImprenditoreUpdateNote } from '@lib/imprenditore/funImprenditoreUpdateNote.mjs'
import { validaNotaImprenditore } from '@lib/validate/validaNotaImprenditore.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	note: string
}

/**
 * The operator's free-text note about an imprenditore.
 *
 * Its own mutation rather than a field of `imprenditoreUpdate`, because it is not part of the
 * anagrafica: `imprenditoreUpdate` `$set`s the whole `anagrafica` sub-document, and the note is what an
 * operator wrote *about* the account, not what the imprenditore declared. Same reason it sits at the
 * top level of the document.
 *
 * `note` is `String!` and not nullable: the empty string is how the note is cleared, and a nullable
 * argument would give "leave it alone" and "remove it" the same wire value.
 */
export const imprenditoreUpdateNote = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: "aggiorna la nota interna sull'imprenditore",
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		note: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			// Inside the try like every sibling: `throwErrorWrongUserInput` raises a GraphQLError and
			// tryCatchRethrow passes those through with their own 400, un-Sentried.
			await funImprenditoreUpdateNote(args._id, validaNotaImprenditore(args.note))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
