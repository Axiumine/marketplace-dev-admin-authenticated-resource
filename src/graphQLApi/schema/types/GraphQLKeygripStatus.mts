import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/*
 * ⚠️ **Nothing in this file has a `material` field, and nothing in it ever may** (ADR-034, E01-S14).
 *
 * The record these types describe holds the platform's cookie-signing keys. An admin who could read
 * one back could sign a session cookie for any account on the platform — a strictly larger power than
 * "may rotate the keys", which is the one this screen exists to grant. `schema.test.mts` asserts the
 * absence by name on all three types, so a field added here fails a test rather than changing a snapshot.
 *
 * What is safe, and why: the key **ids** (`k1`, `k2`, …) are counters, the `createdAt` stamps are dates,
 * and the fingerprint is a sha256 over the ordered ids — see `keygripFingerprint`, which takes the ids
 * precisely so that publishing it is harmless. None of it narrows a 64-byte secret by one bit.
 */

/*
 * One key in the array, as an admin needs to see it.
 *
 * `ageDays` is the key's own age, computed here rather than left to the client because it is the
 * server's clock that every keygrip decision is taken against, and a browser one rotation behind would
 * be doing the arithmetic against a record that no longer exists.
 *
 * ⚠️ **It is not the retirement predicate, and reading it as one is the mistake the 2026-08-28 amendment
 * to ADR-034 records.** A rotation retires the tail once thirty days have passed since it *stopped
 * signing* — `isTailRetirable`, which reads the `createdAt` of the key in front of it. Under a cadence
 * faster than monthly the two diverge, and a key young by `ageDays` can already be retirable. Rendering
 * the demotion age is E17-S08's call; this field answers what it always answered.
 */
export const GraphQLKeygripKeyInfo = new GraphQLObjectType({
	name: 'GraphQLKeygripKeyInfo',
	fields: () => ({
		id: { type: new GraphQLNonNull(GraphQLString) },
		createdAt: { type: new GraphQLNonNull(GraphQLString) },
		ageDays: { type: new GraphQLNonNull(GraphQLInt) }
	})
})

/*
 * One row of the holders table: a service that has read the record and is signing with what it read.
 *
 * `current` is answered here rather than by the client comparing strings, for the same reason `ageDays`
 * is: the comparison is against the record this very read returned, so the two cannot be a rotation
 * apart. A row is missing rather than `current: false` when its service has stopped heartbeating for an
 * hour — see `KEYGRIP_HOLDER_TTL_SECONDS`. Missing and stale mean different things: gone, versus here
 * and behind.
 */
export const GraphQLKeygripHolder = new GraphQLObjectType({
	name: 'GraphQLKeygripHolder',
	fields: () => ({
		service: { type: new GraphQLNonNull(GraphQLString) },
		fingerprint: { type: new GraphQLNonNull(GraphQLString) },
		lastSeen: { type: new GraphQLNonNull(GraphQLString) },
		current: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})

// The whole answer. `fingerprint` is the record's own, which is what every holder row is compared
// against, and `version` is what a rotation bumps — together they are how an admin tells two records
// apart without seeing either.
export const GraphQLKeygripStatus = new GraphQLObjectType({
	name: 'GraphQLKeygripStatus',
	fields: () => ({
		version: { type: new GraphQLNonNull(GraphQLInt) },
		fingerprint: { type: new GraphQLNonNull(GraphQLString) },
		keys: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLKeygripKeyInfo))) },
		holders: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLKeygripHolder))) }
	})
})
