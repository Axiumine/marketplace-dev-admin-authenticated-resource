import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const create = vi.fn()
const updateOne = vi.fn()
const shopOwnerExists = vi.fn()

// No `deleteOne`: since `company` gained its `deleted` column the delete is a `$set` like every other
// one on this tier, and leaving the method on the mock would let a rewrite go back to a hard delete
// without a single test noticing.
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Company', () => ({
	Company: { create, updateOne }
}))

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { exists: shopOwnerExists }
}))

const { duplicateKey } = await import('../src/lib/mongo/duplicateKey.mts')
const { funCompanyAdd } = await import('../src/lib/company/funCompanyAdd.mts')
const { funCompanyDelete } = await import('../src/lib/company/funCompanyDelete.mts')
const { funCompanyUpdate } = await import('../src/lib/company/funCompanyUpdate.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439014')
const idShopOwner = new Types.ObjectId('507f1f77bcf86cd799439013')

const data = {
	legalName: 'Pizzeria da Mario S.r.l.',
	vatNumber: '12345678901',
	taxCode: '12345678901',
	contactPerson: 'Mario Rossi',
	administrator: 'Mario Rossi',
	uniqueCode: 'ABC1234',
	certifiedEmail: 'pizzeria@pec.test',
	address: {
		street: 'Via Milano 9',
		postalCode: '20100',
		city: 'Milano',
		province: 'MI',
		position: { type: 'Point', coordinates: [9.19, 45.46] }
	},
	registryExtract: 'registryExtract-2026'
} as never

const duplicate = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })

/** The chain ends in `.exec()`, as everywhere else on this tier. */
function mockUpdateMatched(matchedCount: number) {
	updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ matchedCount, modifiedCount: 0 }) })
}

describe('duplicateKey', () => {
	// Duck-typed on `code` rather than `instanceof MongoServerError`: a second copy of the mongodb
	// driver under a transitive dependency makes the instanceof false while the code stays 11000, and
	// the failure mode of getting that wrong is a duplicate key surfacing as a 500. It lives with the
	// company tests because `company` is the only collection left carrying a unique index: `vatNumber_unique`
	// and `certifiedEmail_unique` both live there.
	it.each([
		['the driver’s duplicate-key error', duplicate(), true],
		['a plain object carrying the code', { code: 11000 }, true],
		['another driver error', Object.assign(new Error('rete'), { code: 'ECONNRESET' }), false],
		['a different numeric code', { code: 121 }, false],
		['an error with no code at all', new Error('boom'), false],
		['an empty object', {}, false],
		['null', null, false],
		['undefined', undefined, false],
		['a string', 'E11000 duplicate key error', false],
		['a number', 11000, false]
	])('reads %s as %s', (_desc, value, expected) => {
		expect(duplicateKey(value)).toBe(expected)
	})
})

describe('funCompanyAdd', () => {
	beforeEach(() => {
		create.mockReset().mockResolvedValue({})
		shopOwnerExists.mockReset().mockResolvedValue({ _id: idShopOwner })
	})

	it('writes the company under the owner, minting the id', async () => {
		await expect(funCompanyAdd(idShopOwner, data)).resolves.toBeUndefined()

		const [doc] = create.mock.calls[0]
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
		expect(doc.idShopOwner).toBe(idShopOwner)
		// Sorted, because the assertion sorts: the literal has to be in the same order or the comparison
		// fails on ordering alone while the two sets are identical.
		expect(Object.keys(doc).sort()).toEqual([
			'_id',
			'address',
			'administrator',
			'certifiedEmail',
			'contactPerson',
			'idShopOwner',
			'legalName',
			'registryExtract',
			'taxCode',
			'uniqueCode',
			'vatNumber'
		])
	})

	// Every marketplace-common model declares `_id` without a default, which switches auto-generation
	// off, so an id minted once at module load would work exactly once.
	it('mints a distinct id for every company', async () => {
		await funCompanyAdd(idShopOwner, data)
		await funCompanyAdd(idShopOwner, data)

		expect(create.mock.calls[0][0]._id).not.toEqual(create.mock.calls[1][0]._id)
	})

	// ⚠️ The check that stops an orphan: `shopOwnerCompanies` lists by owner, so a company under an
	// shopOwner that does not exist is reachable only through the same wrong id that created it.
	it('refuses to create a company under an shopOwner that does not exist', async () => {
		shopOwnerExists.mockResolvedValueOnce(null)

		expect(await rejection(funCompanyAdd(idShopOwner, data))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'shopOwner not found'
		})
		expect(create).not.toHaveBeenCalled()
	})

	// Soft-deleted counts as absent, and `trusted()` is what keeps the `$exists` clause from being
	// rewritten by mongoose's global sanitizeFilter into a literal comparison that matches nothing.
	it('looks the owner up by id, excluding the soft-deleted', async () => {
		await funCompanyAdd(idShopOwner, data)

		const [filter] = shopOwnerExists.mock.calls[0]
		expect(filter._id).toBe(idShopOwner)
		expect(filter.deleted.$exists).toBe(false)
	})

	// Both `vatNumber_unique` and `certifiedEmail_unique` can fire, the driver's error does not say which, and guessing
	// would send the operator to the wrong box.
	it('turns a unique-index violation into a 409 naming both candidates', async () => {
		create.mockRejectedValueOnce(duplicate())

		expect(await rejection(funCompanyAdd(idShopOwner, data))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'VAT number or certified email already registered by another company'
		})
	})

	it('rethrows any other driver error untouched', async () => {
		const broken = Object.assign(new Error('validation fallita'), { code: 121 })
		create.mockRejectedValueOnce(broken)

		await expect(funCompanyAdd(idShopOwner, data)).rejects.toBe(broken)
	})
})

describe('funCompanyUpdate', () => {
	beforeEach(() => updateOne.mockReset())

	it('replaces the company’s fields in a single write', async () => {
		mockUpdateMatched(1)

		await expect(funCompanyUpdate(_id, data)).resolves.toBeUndefined()

		// One `$set`, and `idShopOwner` is not in it — it is not in `ICompanyValidata` either, which is
		// what keeps a company from being reassigned by editing its card.
		expect(updateOne).toHaveBeenCalledExactlyOnceWith({ _id }, { $set: data })
	})

	it('turns a unique-index violation into a 409 naming both candidates', async () => {
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(duplicate()) })

		expect(await rejection(funCompanyUpdate(_id, data))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'VAT number or certified email already registered by another company'
		})
	})

	it('rethrows any other driver error untouched', async () => {
		const broken = Object.assign(new Error('validation fallita'), { code: 121 })
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(broken) })

		await expect(funCompanyUpdate(_id, data)).rejects.toBe(broken)
	})

	// Saving a card unchanged still matched, and that is a success — the convention every write on this
	// tier follows.
	it('accepts a write that changed nothing, as long as the company exists', async () => {
		mockUpdateMatched(1)

		await expect(funCompanyUpdate(_id, data)).resolves.toBeUndefined()
	})

	it('raises a 404 when no company carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funCompanyUpdate(_id, data))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'company not found'
		})
	})
})

describe('funCompanyDelete', () => {
	beforeEach(() => updateOne.mockReset())

	// A soft delete, like every other delete on this tier since `company` gained the column: the row stays
	// and `deleted` gets a numeric timestamp, cast to the schema's Date path by mongoose. Nothing else is
	// touched — `$set` names one field and the filter is the id alone.
	it('stamps deleted and touches nothing else', async () => {
		mockUpdateMatched(1)

		await expect(funCompanyDelete(_id)).resolves.toBeUndefined()

		const [filter, update] = updateOne.mock.calls[0]
		expect(updateOne).toHaveBeenCalledOnce()
		expect(filter).toEqual({ _id })
		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		expect(typeof update.$set.deleted).toBe('number')
	})

	// `matchedCount`, not `modifiedCount`: 0 matched is a stale Elimina button naming a row already gone,
	// while re-deleting one that is already stamped still matched and is the state the operator asked for.
	it('raises a 404 when no company carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funCompanyDelete(_id))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'company not found'
		})
	})
})
