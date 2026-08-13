import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { GraphQLEnumType } from 'graphql'

/**
 * Which collection an account authenticates against — the platform's whole notion of a role (ADR-002).
 *
 * ⚠️ **Built from `TIER`, never spelled out here.** The tier is a segment of the session index key and of
 * the reuse trail key, so a value this enum accepted and the key builders did not would name a key that has
 * never existed — and the console would answer "no sessions" for an account that has several. Deriving the
 * values means a fifth tier appears here the moment it exists, and cannot appear here before.
 *
 * An enum rather than a string, because every argument that takes one is a *lookup* key: a typo would
 * otherwise be a successful query over an empty keyspace, which reads exactly like a clean account.
 */
export const GraphQLTier = new GraphQLEnumType({
	name: 'GraphQLTier',
	values: Object.fromEntries(Object.values(TIER).map((tier) => [tier, { value: tier }]))
})
