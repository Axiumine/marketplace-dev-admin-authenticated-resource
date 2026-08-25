import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const updateOne = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { updateOne } }))

const { funUserUpdateStatus } = await import('../src/lib/user/funUserUpdateStatus.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** The helper ends in `.exec()`, so the chain has to be mocked one level deep. */
function mockUpdateMatched(matchedCount: number) {
	updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ matchedCount, modifiedCount: 0 }) })
}

/** The two arguments of the `updateOne` call, as it was actually made. */
function updateArgs() {
	const [filter, update] = updateOne.mock.calls[0]

	return { filter, update }
}

describe('funUserUpdateStatus', () => {
	beforeEach(() => updateOne.mockReset())

	/*
	 * ⚠️ **The whole point of the helper: true stores the flag, false REMOVES it — it never stores `false`.**
	 * Every reader of `user.disabled` tests truthiness, so `{disabled: false}` would behave correctly today
	 * and still be wrong: the collection would hold two spellings of "allowed to log in", and
	 * `usersActiveTblDb` filters the live customers with `{disabled: {$exists: false}}` — every account ever
	 * re-enabled would drop off the operator's default page and reappear under the disabled filter.
	 */
	it.each([
		[true, { $set: { disabled: true } }],
		[false, { $unset: { disabled: 1 } }]
	])('disabled=%s writes %o', async (disabled, update) => {
		mockUpdateMatched(1)

		await expect(funUserUpdateStatus(_id, disabled)).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update })
	})

	// Asserted as an absence: `user` is encrypted whole, and the one operator write on it must stay off
	// every encrypted path. A `$set` of `personalData` or an address here would be refused by the
	// validator's `binData` declaration at runtime — this is the same rule, one layer earlier.
	it.each([[true], [false]])('names no field but disabled, with disabled=%s', async (disabled) => {
		mockUpdateMatched(1)

		await funUserUpdateStatus(_id, disabled)

		const { update } = updateArgs()

		expect(Object.keys({ ...update.$set, ...update.$unset })).toEqual(['disabled'])
	})

	// A flag re-set to the value it already held matches without modifying, and that is a success: the
	// operator asked for a state, and the state is what the document is in.
	it('accepts a write that changed nothing, as long as the customer exists', async () => {
		mockUpdateMatched(1)

		await expect(funUserUpdateStatus(_id, true)).resolves.toBeUndefined()
	})

	// 0 matched is the only failure this write has: an id naming no customer. It is a 404 rather than a
	// 500 because the operator sent it — a stale row in a table open in another tab.
	it('raises a 404 when no customer carries the id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funUserUpdateStatus(_id, true))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'user not found'
		})
	})
})
