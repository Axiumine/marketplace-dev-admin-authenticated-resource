import { GraphQLTier } from '@ptypes/GraphQLTier.mjs'
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/*
 * ⚠️ **Nothing in this file has a field capable of holding a token, and nothing in it ever may**
 * (BCON-01). `schema.test.mts` enumerates these fields against an exact expected set, so a field added
 * here fails a test rather than quietly reaching a screen.
 *
 * ⚠️ **Nothing network- or device-derived either** — no address, not truncated, not hashed, not salted.
 * That is the standing decision on session rows, and it is why an admin cannot answer "where was this
 * session used from" on this platform. The answer to a compromise report is to end the sessions, which is
 * what the two mutations beside this type do.
 */

/**
 * One live session of one account, as the console lists it.
 *
 * `id` is the session index field — the SHA-256 of the prefixed refresh token, never the token. It is
 * shown so a row can be pointed at and revoked; why a digest is safe to publish *and* safe to accept back
 * is written out on `ISessionRow`, and turns on the `access:` / `refresh:` prefix that every raw-token key
 * carries and a bare index field does not.
 *
 * `mintedAt` is the *login* this session descends from, not the last rotation — a session that refreshes
 * every fifteen minutes must not look freshly created to the admin reading the row. `familyId` is the
 * lineage handle: two rows sharing one are the same login seen before and after a rotation race, which is
 * the one thing that explains a duplicate an admin would otherwise read as a second device.
 */
export const GraphQLSession = new GraphQLObjectType({
	name: 'GraphQLSession',
	fields: () => ({
		id: { type: new GraphQLNonNull(GraphQLString) },
		tier: { type: new GraphQLNonNull(GraphQLTier) },
		mintedAt: { type: new GraphQLNonNull(GraphQLString) },
		familyId: { type: new GraphQLNonNull(GraphQLString) }
	})
})
