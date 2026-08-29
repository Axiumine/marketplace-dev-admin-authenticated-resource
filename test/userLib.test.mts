import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const updateOne = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { updateOne } }))

const { funUserUpdateStatus } = await import('../src/lib/user/funUserUpdateStatus.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** The operator taking the decision — `ctx.state.user._id` at the resolver, never a wire argument. */
const adminId = new Types.ObjectId('507f1f77bcf86cd799439099')

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

	/** The status write as the resolver makes it, with only what a case cares about spelled out. */
	const status = (over: Partial<Parameters<typeof funUserUpdateStatus>[0]>) =>
		funUserUpdateStatus({ _id, disabled: false, adminId, ...over })

	/*
	 * ⚠️ **The whole point of the helper: true stores the flag, false REMOVES it — it never stores `false`.**
	 * Every reader of `user.disabled` tests truthiness, so `{disabled: false}` would behave correctly today
	 * and still be wrong: the collection would hold two spellings of "allowed to log in", and
	 * `usersActiveTblDb` filters the live customers with `{disabled: {$exists: false}}` — every account ever
	 * re-enabled would drop off the operator's default page and reappear under the disabled filter.
	 */
	it.each([
		[true, { $set: { disabled: true, disabledBy: adminId, disabledReason: 'Chargeback ring' } }],
		[false, { $unset: { disabled: 1, disabledBy: 1, disabledReason: 1 } }]
	])('disabled=%s writes %o', async (disabled, update) => {
		mockUpdateMatched(1)

		await expect(status({ disabled, disabledReason: disabled ? 'Chargeback ring' : undefined })).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update })
	})

	/*
	 * Asserted as an absence: `user` is encrypted whole, and the one operator write on it must stay off
	 * every personal path. `disabledReason` is the single encrypted field it may name — the model's plugin
	 * rewrites the `$set` operand into ciphertext on the way past — and a `$set` of `personalData` or of an
	 * address here would be refused by the validator's `binData` declaration at runtime.
	 *
	 * ⚠️ **The three names move as one and in this order** (ADR-044): a suspension that wrote only two of
	 * them would be refused by `dependencies: { disabled: ['disabledReason'] }`, and a release that cleared
	 * only two would leave a stale reason standing beside a live account.
	 */
	it.each([[true], [false]])('names no field but the disabled trio, with disabled=%s', async (disabled) => {
		mockUpdateMatched(1)

		await status({ disabled, disabledReason: disabled ? 'Chargeback ring' : undefined })

		const { update } = updateArgs()

		expect(Object.keys({ ...update.$set, ...update.$unset })).toEqual(['disabled', 'disabledBy', 'disabledReason'])
	})

	// ⚠️ No cascade on this tier, and none is missing: a customer owns no company and no item — the FK
	// chain runs `shopOwner -> company -> item` and `user` sits outside it. A single write, no transaction.
	it('writes once and opens no transaction', async () => {
		mockUpdateMatched(1)

		await status({ disabled: true, disabledReason: 'Chargeback ring' })

		expect(updateOne).toHaveBeenCalledOnce()
	})

	// A flag re-set to the value it already held matches without modifying, and that is a success: the
	// operator asked for a state, and the state is what the document is in.
	it('accepts a write that changed nothing, as long as the customer exists', async () => {
		mockUpdateMatched(1)

		await expect(status({ disabled: true, disabledReason: 'Chargeback ring' })).resolves.toBeUndefined()
	})

	// 0 matched is the only failure this write has: an id naming no customer. It is a 404 rather than a
	// 500 because the operator sent it — a stale row in a table open in another tab.
	it('raises a 404 when no customer carries the id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(status({ disabled: true, disabledReason: 'Chargeback ring' }))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'user not found'
		})
	})
})
