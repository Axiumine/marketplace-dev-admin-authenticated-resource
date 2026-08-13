import { GraphQLReuseEventAction } from '@ptypes/GraphQLReuseEventAction.mjs'
import { GraphQLTier } from '@ptypes/GraphQLTier.mjs'
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * One line of an account's reuse trail: a lineage that was revoked, and why (E17-S05).
 *
 * ⚠️ **Five fields, and the omissions are the contract** — no token, no digest of one, no prefix of one,
 * nothing network-derived. This type mirrors `IReuseEvent` field for field precisely so that the store's
 * rule and the wire's rule cannot be two different rules; `schema.test.mts` enumerates the set (BCON-01).
 *
 * `familyId` is the handle the revocation was issued against, which is what ties a line here to the rows
 * `sessions` no longer returns — the whole point of the trail: a mass logout an operator can explain
 * instead of a mystery ticket.
 *
 * `at` is epoch millis as a string, as it is stored. A number would be a number in this process and a
 * string in the next one, and the console formats it against the operator's own locale either way.
 */
export const GraphQLReuseEvent = new GraphQLObjectType({
	name: 'GraphQLReuseEvent',
	fields: () => ({
		familyId: { type: new GraphQLNonNull(GraphQLString) },
		tier: { type: new GraphQLNonNull(GraphQLTier) },
		accountId: { type: new GraphQLNonNull(GraphQLString) },
		action: { type: new GraphQLNonNull(GraphQLReuseEventAction) },
		at: { type: new GraphQLNonNull(GraphQLString) }
	})
})
