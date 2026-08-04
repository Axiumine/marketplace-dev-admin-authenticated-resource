import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funImprenditoreUpdateStato } from '@lib/imprenditore/funImprenditoreUpdateStato.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	_id: Types.ObjectId
	disabled: boolean
	waitApprov: boolean
}

/**
 * The disable switch and the manual-approval gate.
 *
 * Both arguments are `Boolean!`, not optional: the operator app sends the state of both toggles on
 * every save, so "not sent" would only ever mean a bug on the client. Nullable arguments here would
 * also make the mutation a partial update, and the one thing a partial update of these two cannot
 * express is turning a flag *off* — `null` for "leave alone" and `null` for "clear it" are the same
 * wire value.
 *
 * No validation call: `Boolean!` is the whole contract, and graphql-js has already enforced it by the
 * time this runs.
 */
export const imprenditoreUpdateStato = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: "aggiorna lo stato dell'account imprenditore",
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		disabled: { type: new GraphQLNonNull(GraphQLBoolean) },
		waitApprov: { type: new GraphQLNonNull(GraphQLBoolean) }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funImprenditoreUpdateStato(args._id, args.disabled, args.waitApprov)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
