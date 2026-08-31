import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funKeygripResweep } from '@lib/keygrip/funKeygripResweep.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'

export const keygripResweep = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'signs every account out again, to finish a retirement whose session sweep did not reach the whole platform',
	/*
	 * ⚠️ No arguments, and in particular not a key id and not a list of accounts. This mutation does not
	 * touch the keygrip record — the key it is finishing the work of is already out of it — and the sweep
	 * it runs is the whole platform by definition, so an argument could only ever narrow it into the
	 * partial sweep that R55 is about.
	 *
	 * ⚠️ `Boolean!`, and true means the sweep reached every account. A run that left accounts standing is
	 * a 500 naming how many, because the admin's next move depends on it: this is a mutation whose whole
	 * purpose is finishing something, and answering `true` for "mostly" would hide exactly the state it
	 * exists to clear.
	 */
	args: {},
	async resolve(_: unknown, __: unknown, ctx: IContextAdminAuthenticatedResource) {
		try {
			// The admin's id meters the rate limit and signs the audit event, and travels nowhere else.
			await funKeygripResweep(ctx.state.user._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
