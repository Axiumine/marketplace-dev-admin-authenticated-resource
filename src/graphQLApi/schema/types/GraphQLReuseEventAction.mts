import { REUSE_EVENT_ACTIONS } from '@axiumine/marketplace-common/others/ReuseEventAction'
import { GraphQLEnumType } from 'graphql'

/**
 * Why a lineage was revoked, as the console renders it (E17-S01, E17-S05).
 *
 * ⚠️ **Its own file, and its values are `REUSE_EVENT_ACTIONS` — not a copy of them.** The backend writes
 * these strings into Redis and `marketplace-admin` generates a TypeScript union from this enum; two
 * hand-written lists would drift the moment a third case is added, and the drift would surface as an
 * operator reading a blank cell rather than as a failing build. `schema.test.mts` asserts the two value
 * sets are equal, which is the check E17-S01 asks for and which only means anything because both sides
 * ultimately read the same constant.
 *
 * ⚠️ **An operator's own revocation is not a value here.** E17's open question 4 answered "not
 * attributable"; adding a case would answer it by accident and would need its own retention decision.
 */
export const GraphQLReuseEventAction = new GraphQLEnumType({
	name: 'GraphQLReuseEventAction',
	values: Object.fromEntries(REUSE_EVENT_ACTIONS.map((action) => [action, { value: action }]))
})
