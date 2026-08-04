import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funShopOwnerUpdateNote } from '@lib/shopOwner/funShopOwnerUpdateNote.mjs'
import { validateShopOwnerNote } from '@lib/validate/validateShopOwnerNote.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	notes: string
}

/**
 * The operator's free-text note about an shopOwner.
 *
 * Its own mutation rather than a field of `shopOwnerUpdate`, because it is not part of the
 * personalData: `shopOwnerUpdate` `$set`s the whole `personalData` sub-document, and the note is what an
 * operator wrote *about* the account, not what the shopOwner declared. Same reason it sits at the
 * top level of the document.
 *
 * `notes` is `String!` and not nullable: the empty string is how the note is cleared, and a nullable
 * argument would give "leave it alone" and "remove it" the same wire value.
 */
export const shopOwnerUpdateNote = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates the internal note about the shopOwner',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		notes: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			// Inside the try like every sibling: `throwErrorWrongUserInput` raises a GraphQLError and
			// tryCatchRethrow passes those through with their own 400, un-Sentried.
			await funShopOwnerUpdateNote(args._id, validateShopOwnerNote(args.notes))
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
