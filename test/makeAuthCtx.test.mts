import { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'

import { makeAuthCtx } from '../src/lib/auth/makeAuthCtx.mts'

const OID = '507f1f77bcf86cd799439011'

describe('makeAuthCtx', () => {
	// Redis stores everything as strings; the rest of the service expects a real ObjectId, so this
	// is where the conversion has to happen — resolvers must never re-parse it.
	it('turns the Redis hash into the node-side context, rehydrating _id as an ObjectId', () => {
		const user = makeAuthCtx({ _id: OID, email: 'admin@marketplace.test' })

		expect(user._id).toBeInstanceOf(Types.ObjectId)
		expect(user._id.toHexString()).toBe(OID)
		expect(user.email).toBe('admin@marketplace.test')
	})
})
