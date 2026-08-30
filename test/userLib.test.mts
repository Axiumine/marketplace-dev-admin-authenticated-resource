import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const updateOne = vi.fn()
const countDocuments = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { updateOne, countDocuments } }))

const { funUserDelete } = await import('../src/lib/user/funUserDelete.mts')
const { funUserUpdateStatus } = await import('../src/lib/user/funUserUpdateStatus.mts')
const { default: usersStatsDb } = await import('../src/lib/user/usersStatsDb.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** The admin taking the decision — `ctx.state.user._id` at the resolver, never a wire argument. */
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

describe('funUserDelete', () => {
	beforeEach(() => updateOne.mockReset())

	// Soft delete, like every other delete on this platform: the document stays and gains a `deleted`
	// instant. `checkUserAuthorizationDisDel` already refuses a stamped account at the login gate, so this
	// one write is what shuts the account and the mutation revokes the live sessions on top of it.
	it('stamps deleted on an account that is still open', async () => {
		mockUpdateMatched(1)

		await expect(funUserDelete(_id, adminId)).resolves.toBeUndefined()

		const { filter, update } = updateArgs()

		expect(filter).toEqual({ _id, deleted: trusted({ $exists: false }) })
		expect(update.$set.deleted).toBeInstanceOf(Date)
	})

	// ADR-044: `deletedBy` is what tells an admin closure apart from a self-service one, and the
	// distinction is carried by the field's presence rather than by any value naming a collection — the
	// customer's own `funUserDel` writes the stamp and leaves this absent.
	it('records the admin who closed the account', async () => {
		mockUpdateMatched(1)

		await funUserDelete(_id, adminId)

		expect(updateArgs().update.$set.deletedBy).toBe(adminId)
	})

	/*
	 * Asserted as an absence, and the absence is the whole parity rule. Two fields move and no third:
	 * no `waitApprov` — a customer never had an approval gate to be dropped from — and above all no
	 * `disabled*`, in either direction. A closure that cleared the trio would let a suspended customer
	 * launder the sanction away, and ADR-046 restores the document with the trio exactly as it stands.
	 */
	it('names deleted and deletedBy and no other field', async () => {
		mockUpdateMatched(1)

		await funUserDelete(_id, adminId)

		const { update } = updateArgs()

		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted', 'deletedBy'])
	})

	// ⚠️ No cascade and no transaction, and neither is missing: a customer owns no company and no item —
	// the FK chain runs `shopOwner -> company -> item` and `user` sits outside it, so ADR-045's storefront
	// withdrawal has no counterpart here. One write cannot be half-applied. `mongoose` is deliberately not
	// mocked in this file, so a source line reaching for `startSession()` fails here rather than passing.
	it('writes once and opens no transaction', async () => {
		mockUpdateMatched(1)

		await funUserDelete(_id, adminId)

		expect(updateOne).toHaveBeenCalledOnce()
	})

	/*
	 * ⚠️ **The clock starts once.** `deleted` is what the retention sweep measures from and what ADR-046
	 * turns into an undo window, so a second closure over the same document would push the scrub thirty
	 * days further out and quietly postpone the erasure the first one promised. The `$exists: false`
	 * clause is what stops it, and a 404 is the honest answer: the account is already gone. `trusted()`
	 * is not decoration — `sanitizeFilter` is global and strips a bare `$exists`, which would leave the
	 * filter matching closed accounts too.
	 */
	it('refuses an account that is already closed rather than resetting its retention clock', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funUserDelete(_id, adminId))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'user not found'
		})
	})
})

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
	 * re-enabled would drop off the admin's default page and reappear under the disabled filter.
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
	 * Asserted as an absence: `user` is encrypted whole, and the one admin write on it must stay off
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
	// admin asked for a state, and the state is what the document is in.
	it('accepts a write that changed nothing, as long as the customer exists', async () => {
		mockUpdateMatched(1)

		await expect(status({ disabled: true, disabledReason: 'Chargeback ring' })).resolves.toBeUndefined()
	})

	// 0 matched is the only failure this write has: an id naming no customer. It is a 404 rather than a
	// 500 because the admin sent it — a stale row in a table open in another tab.
	it('raises a 404 when no customer carries the id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(status({ disabled: true, disabledReason: 'Chargeback ring' }))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'user not found'
		})
	})
})

describe('usersStatsDb', () => {
	// No filter and no argument, exactly like `shopOwnersStatsDb`. ⚠️ The count is the number the chart's
	// points add up to, so a `{ deleted: { $exists: false } }` added here — which reads like an
	// improvement — would put two numbers on one screen that look like the same number and disagree.
	it('counts every customer, closed and suspended ones included', async () => {
		countDocuments.mockResolvedValueOnce(7)

		await expect(usersStatsDb()).resolves.toBe(7)
		expect(countDocuments).toHaveBeenCalledExactlyOnceWith()
	})
})
