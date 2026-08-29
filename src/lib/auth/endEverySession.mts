import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { deleteSession } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'

/**
 * Logs the calling admin out of everything, everywhere (E15-S05). Called after a credential write
 * has landed, never before one and never instead of one.
 *
 * ⚠️ **The calling session goes with the rest — decided 2026-08-10, and it is not a rough edge to
 * smooth.** Sparing the caller is friendlier and is what a fair number of products ship; it was
 * rejected because it defeats the one scenario this exists for. Someone changing their password
 * because they believe another person is inside the account cannot tell which live session is theirs,
 * and neither can the server: an exemption is granted to *whichever session sent the mutation*, and an
 * attacker holding the password can send it. "Revoke all but me" is not a weaker "revoke all", it is a
 * rule an attacker can aim at. It matters most here of the three tiers: an Admin session reaches every
 * shop owner, every company and the keygrip rotation.
 *
 * ⚠️ **Refresh sessions first, the caller's access key second, and the order is what makes an interrupted
 * run safe.** The reverse leaves the refresh sessions alive, which is the whole attack: the intruder
 * simply refreshes and gets another access token. This way a process death between the two steps leaves at
 * worst the caller's own access token alive for the minutes it has left, and since R54 usually not even
 * that — see below.
 *
 * ⚠️ **The second step is a backstop, not the only way an access token dies here — this docblock said
 * otherwise until 2026-08-25.** It predated R54 and described the other devices' access tokens as
 * surviving until their own expiry. They do not: the index files refresh
 * sessions alone (`indexSession`), but each refresh hash records the key of the access session minted
 * beside it, and `revokeAllSessionsForAccount` retires that half of every session before it deletes the
 * hash. What the explicit `deleteSession` below still covers is the pair R54 cannot reach — a session
 * minted before the `accessKey` field existed, and a refresh hash that expired between the index read and
 * the `hGet` — and it costs one `del` of a key this service is the only one able to name, since the caller
 * handed it the token.
 *
 * `TIER.admin`, and the tier is not incidental: the index key is per tier, so the wrong constant here
 * reads an index that is empty or — worse — another tier's, and revokes nothing while reporting success.
 *
 * The missing-header branch is the introspection bypass, which reaches a resolver with no session at
 * all: there is no caller to log out, so there is no key to delete.
 */
export async function endEverySession(ctx: IContextAdminAuthenticatedResource) {
	await revokeAllSessionsForAccount({ store: redisClient, tier: TIER.admin, accountId: `${ctx.state.user._id}` })

	const authorization = ctx.request.header?.authorization

	if (typeof authorization === 'undefined') {
		return
	}

	// `Bearer access:<token>` minus the scheme is the prefixed token every session helper takes, and the
	// `access:` half must stay: it is what tells an access hash from a refresh one inside the digest.
	await deleteSession(redisClient, authorization.replace('Bearer ', ''))
}
