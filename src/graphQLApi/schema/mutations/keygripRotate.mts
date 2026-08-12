import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { funKeygripRotate } from '@lib/keygrip/funKeygripRotate.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'

export const keygripRotate = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'mints a new cookie-signing key for the whole platform and retires the ones nothing can still be signed with',
	/*
	 * ⚠️ No arguments, and in particular no key material and no version. What the new key is, and which
	 * number it lands under, are decided here from the record — a mutation that accepted either would let
	 * a caller install a key of their choosing, which is the ability to mint a session cookie for any
	 * account on the platform. The operator asks for a rotation; they do not get to say what it produces.
	 *
	 * ⚠️ `Boolean!` for the same reason: the answer is "it happened", never the keys. Everything an
	 * operator needs to see afterwards — the version, the fingerprint, which service has adopted it — is
	 * `keygripStatus`, which reads the ids and never the material.
	 */
	args: {},
	async resolve(_: unknown, __: unknown, ctx: IContextAdminAuthenticatedResource) {
		try {
			// The operator's id is the session's, and travels only into the audit event.
			await funKeygripRotate(ctx.state.user._id)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
