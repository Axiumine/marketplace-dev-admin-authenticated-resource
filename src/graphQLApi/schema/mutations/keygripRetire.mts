import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funKeygripRetire } from '@lib/keygrip/funKeygripRetire.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

export const keygripRetire = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'drops one cookie-signing key from the whole platform and signs every account out, the calling admin included',
	/*
	 * ⚠️ One argument, and it is an id — never key material, never a version. The id is public by
	 * construction: `keygripStatus` renders it and the fingerprint is computed over the ids. What the
	 * admin is naming is which key to drop, and the key set the drop applies to is whichever one the
	 * record holds at that moment, so a stale screen loses the compare rather than retiring the wrong key.
	 *
	 * ⚠️ `Boolean!` for the same reason `keygripRotate` answers one: the reply is "it happened", and the
	 * key set afterwards is `keygripStatus`, which reads the ids and never the material. **Not the number
	 * of sessions ended**, which the audit event carries instead: this reply reaches a screen the caller
	 * has just been signed out of, and a count of live sessions is a platform-size figure that nothing on
	 * that screen needs.
	 */
	args: { id: { type: new GraphQLNonNull(GraphQLString) } },
	async resolve(_: unknown, args: { id: string }, ctx: IContextAdminAuthenticatedResource) {
		try {
			// The admin's id meters the rate limit and signs the audit event, and travels nowhere else.
			await funKeygripRetire(ctx.state.user._id, args.id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
