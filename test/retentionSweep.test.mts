import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const shopOwnerFind = vi.fn()
const shopOwnerUpdateOne = vi.fn()
const userFind = vi.fn()
const userUpdateOne = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { find: shopOwnerFind, updateOne: shopOwnerUpdateOne }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({ User: { find: userFind, updateOne: userUpdateOne } }))

const { RETENTION_DAYS, retentionCutoff, retentionSweep, scrubCandidates, sweepTier } =
	await import('../src/lib/retention/retentionSweep.mts')

/** The instant every case sweeps at, and the cutoff thirty days behind it. */
const NOW = new Date('2026-08-29T10:00:00.000Z')
const CUTOFF = new Date('2026-07-30T10:00:00.000Z')

/** The marker `trusted()` leaves on an object so `sanitizeFilter` lets its `$`-keys through. */
const TRUSTED = 'Symbol(mongoose#trustedSymbol)'

const symbolsOf = (value: unknown) => Object.getOwnPropertySymbols(value as object).map(String)

/** A stand-in for one collection: `find(…).lean()` answers what it was seeded with, `updateOne(…).exec()` succeeds. */
function fakeModel(docs: { _id: Types.ObjectId; disabled?: boolean }[]) {
	const lean = vi.fn().mockResolvedValue(docs)
	const find = vi.fn().mockReturnValue({ lean })
	const updateOne = vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(undefined) })

	return { find, updateOne }
}

const _idA = new Types.ObjectId('507f1f77bcf86cd799439011')
const _idB = new Types.ObjectId('507f1f77bcf86cd799439012')

describe('the retention window', () => {
	/*
	 * ⚠️ The number is the promise, and it is made twice: ADR-046 turns the window into an *undo* window,
	 * so the same thirty days govern how long the address stays reclaimable and how long the data is kept.
	 * Asserted as a literal because every consequence of moving it is off-platform — a privacy page, a
	 * person's expectation — where no test can follow.
	 */
	it('is thirty days', () => {
		expect(RETENTION_DAYS).toBe(30)
	})

	/*
	 * The exact instant, not "before now": the arithmetic is one subtraction and one multiplication, and a
	 * mutant that added instead of subtracting, or divided instead of multiplying, still produces a Date
	 * that a relative assertion would accept.
	 */
	it('puts the cutoff exactly thirty days behind the instant it is handed', () => {
		expect(retentionCutoff(NOW)).toStrictEqual(CUTOFF)
	})

	it('reads the clock nowhere, so the same instant selects and stamps', () => {
		const other = new Date('2026-01-15T00:00:00.000Z')

		expect(retentionCutoff(other)).toStrictEqual(new Date('2025-12-16T00:00:00.000Z'))
	})
})

describe('scrubCandidates', () => {
	/*
	 * ⚠️ Two clauses and no third. A widened filter is a mass overwrite with no undo, which is why ADR-041
	 * puts the filter in its own function — and why the key count is asserted rather than left to `toEqual`,
	 * which would pass just as happily on a filter that had grown one.
	 */
	it('selects closures older than the cutoff that have not been scrubbed yet, and nothing else', () => {
		const filter = scrubCandidates(CUTOFF)

		expect(Object.keys(filter)).toStrictEqual(['deleted', 'scrubbedAt'])
		expect(filter.deleted.$lte).toBe(CUTOFF)
		expect(filter.scrubbedAt.$exists).toBe(false)
	})

	/*
	 * ⚠️ The assertion that stops a permanent, silent no-op. `sanitizeFilter` is on process-wide and rewrites
	 * an unwrapped `$`-keyed value to `{ $eq: … }`, which matches nothing for ever while every run reports
	 * success. The integration test proves the same thing against a real collection; this one names the cause.
	 */
	it.each([['deleted'], ['scrubbedAt']] as const)('marks the %s clause trusted, so sanitizeFilter leaves it alone', (clause) => {
		expect(symbolsOf(scrubCandidates(CUTOFF)[clause])).toStrictEqual([TRUSTED])
	})
})

describe('sweepTier', () => {
	it('reads the candidates with the filter and the projection the scrub needs', async () => {
		const model = fakeModel([])

		await expect(sweepTier(model, 'user', NOW, CUTOFF)).resolves.toBe(0)

		expect(model.find).toHaveBeenCalledExactlyOnceWith(scrubCandidates(CUTOFF), '_id disabled')
		expect(model.updateOne).not.toHaveBeenCalled()
	})

	it('writes one update per candidate, each addressed by its own _id, and answers how many', async () => {
		const model = fakeModel([{ _id: _idA }, { _id: _idB }])

		await expect(sweepTier(model, 'user', NOW, CUTOFF)).resolves.toBe(2)

		expect(model.updateOne).toHaveBeenCalledTimes(2)
		expect(model.updateOne.mock.calls[0][0]).toEqual({ _id: _idA })
		expect(model.updateOne.mock.calls[1][0]).toEqual({ _id: _idB })
	})

	/*
	 * ⚠️ The placeholder address is derived from the document being written, which is the reason this is one
	 * update per document rather than one `updateMany`: `login.email_unique` has no `sparse` and no partial
	 * filter, so a constant address across two documents is an `E11000` at the moment of erasure.
	 */
	it('gives each document its own placeholder address, and stamps both with the instant it was handed', async () => {
		const model = fakeModel([{ _id: _idA }, { _id: _idB }])

		await sweepTier(model, 'user', NOW, CUTOFF)

		expect(model.updateOne.mock.calls[0][1].$set['login.email']).toBe(`deleted-${_idA.toHexString()}@invalid.local`)
		expect(model.updateOne.mock.calls[1][1].$set['login.email']).toBe(`deleted-${_idB.toHexString()}@invalid.local`)
		expect(model.updateOne.mock.calls[0][1].$set.scrubbedAt).toBe(NOW)
	})

	/*
	 * ⚠️ Why the projection is `_id disabled` and not `_id`. `dependencies: { disabled: ['disabledReason'] }`
	 * refuses a document that keeps `disabled: true` and loses its reason, so a suspended account takes the
	 * overwrite and one that was never parked takes the removal. Passing the wrong half is a
	 * `Document failed validation` on exactly the accounts most likely to reach the sweep.
	 */
	it.each([
		{ name: 'a suspended account', doc: { _id: _idA, disabled: true }, set: true },
		{ name: 'an account that was never parked', doc: { _id: _idA }, set: false },
		{ name: 'an account whose flag was removed rather than set false', doc: { _id: _idA, disabled: false }, set: false }
	])('overwrites the operator reason for $name: $set', async ({ doc, set }) => {
		const model = fakeModel([doc])

		await sweepTier(model, 'user', NOW, CUTOFF)

		const update = model.updateOne.mock.calls[0][1]

		expect('disabledReason' in update.$set).toBe(set)
		expect('disabledReason' in update.$unset).toBe(!set)
	})
})

describe('retentionSweep', () => {
	beforeEach(() => {
		shopOwnerFind.mockReset().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) })
		userFind.mockReset().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) })
		shopOwnerUpdateOne.mockReset().mockReturnValue({ exec: vi.fn().mockResolvedValue(undefined) })
		userUpdateOne.mockReset().mockReturnValue({ exec: vi.fn().mockResolvedValue(undefined) })
	})

	it('reads both collections against one cutoff derived from the instant it was handed', async () => {
		await expect(retentionSweep(NOW)).resolves.toStrictEqual({ shopOwner: 0, user: 0 })

		expect(shopOwnerFind).toHaveBeenCalledExactlyOnceWith(scrubCandidates(CUTOFF), '_id disabled')
		expect(userFind).toHaveBeenCalledExactlyOnceWith(scrubCandidates(CUTOFF), '_id disabled')
	})

	it('counts each collection under its own name', async () => {
		shopOwnerFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: _idA }, { _id: _idB }]) })
		userFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: _idA }]) })

		await expect(retentionSweep(NOW)).resolves.toStrictEqual({ shopOwner: 2, user: 1 })
	})

	/*
	 * ⚠️ Each collection has to be swept as *itself*. The two scrubs differ — a customer's address book goes,
	 * a shop owner's operator notes and their all-or-nothing `personalData` block go — so a sweep that handed
	 * one tier's shape to the other collection would be refused by the validator, or would leave data behind.
	 * Asserted through the update each model actually received, which is the only place the tier is visible.
	 */
	it('sweeps each collection with its own tier', async () => {
		shopOwnerFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: _idA }]) })
		userFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: _idB }]) })

		await retentionSweep(NOW)

		expect(shopOwnerUpdateOne.mock.calls[0][1].$unset).toHaveProperty('notes')
		expect(shopOwnerUpdateOne.mock.calls[0][1].$unset).not.toHaveProperty('addresses')
		expect(userUpdateOne.mock.calls[0][1].$unset).toHaveProperty('addresses')
		expect(userUpdateOne.mock.calls[0][1].$unset).not.toHaveProperty('notes')
	})
})
