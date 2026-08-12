import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/*
 * ⚠️ **Nothing in this file has a `material` field, and nothing in it ever may** (ADR-034, E01-S14).
 *
 * The record these types describe holds the platform's cookie-signing keys. An operator who could read
 * one back could sign a session cookie for any account on the platform — a strictly larger power than
 * "may rotate the keys", which is the one this screen exists to grant. `schema.test.mts` asserts the
 * absence by name on all three types, so a field added here fails a test rather than changing a snapshot.
 *
 * What is safe, and why: the key **ids** (`k1`, `k2`, …) are counters, the `createdAt` stamps are dates,
 * and the fingerprint is a sha256 over the ordered ids — see `keygripFingerprint`, which takes the ids
 * precisely so that publishing it is harmless. None of it narrows a 64-byte secret by one bit.
 */

// One key in the array, as an operator needs to see it. `ageDays` is computed rather than left to the
// client: the retirement rule is "older than SESSION_CAP_DAYS_REMEMBERED days", and it is the server's
// clock that decides, so a screen that did the arithmetic against the browser's clock could show a key
// as retirable while the rotation refuses it.
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
// against, and `version` is what a rotation bumps — together they are how an operator tells two records
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
