import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const updateOne = vi.fn()
const countDocuments = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { updateOne, countDocuments }
}))

const { funShopOwnerDelete } = await import('../src/lib/shopOwner/funShopOwnerDelete.mts')
const { funShopOwnerUpdate } = await import('../src/lib/shopOwner/funShopOwnerUpdate.mts')
const { funShopOwnerUpdateEmail } = await import('../src/lib/shopOwner/funShopOwnerUpdateEmail.mts')
const { funShopOwnerUpdatePreferences } = await import('../src/lib/shopOwner/funShopOwnerUpdatePreferences.mts')
const { funShopOwnerUpdateNote } = await import('../src/lib/shopOwner/funShopOwnerUpdateNote.mts')
const { funShopOwnerUpdateStatus } = await import('../src/lib/shopOwner/funShopOwnerUpdateStatus.mts')
const { default: shopOwnersStatsDb } = await import('../src/lib/shopOwner/shopOwnersStatsDb.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

const personalData = {
	firstName: 'Mario',
	lastName: 'Rossi',
	address: { via: 'Via Roma 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' }
} as never

/** Both fun* helpers end in `.exec()`, so the chain has to be mocked one level deep. */
function mockUpdate(modifiedCount: number) {
	updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ modifiedCount }) })
}

/**
 * As above, for the newer helpers, which key off `matchedCount` instead.
 *
 * The two counts differ exactly when the document was found and the write changed nothing, and that
 * is the case the newer helpers deliberately treat as success — see `funShopOwnerUpdateStatus`.
 */
function mockUpdateMatched(matchedCount: number) {
	updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ matchedCount, modifiedCount: 0 }) })
}

/** A driver error carrying the unique-index code, shaped the way the driver really raises it. */
function duplicateKeyError() {
	return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
}

/** The two arguments of the `updateOne` call, as it was actually made. */
function updateArgs() {
	const [filter, update] = updateOne.mock.calls[0]
	return { filter, update }
}

describe('funShopOwnerDelete', () => {
	beforeEach(() => updateOne.mockReset())

	// Soft delete: the document stays, `deleted` gets a timestamp and the approval flag is dropped
	// so a deleted shopOwner cannot reappear in the "waiting for approval" queue.
	it('stamps deleted and clears waitApprov', async () => {
		mockUpdate(1)

		await expect(funShopOwnerDelete(_id)).resolves.toBeUndefined()

		const [filter, update] = updateOne.mock.calls[0]
		expect(filter).toEqual({ _id })
		expect(update.$unset).toEqual({ waitApprov: 1 })
		expect(typeof update.$set.deleted).toBe('number')
	})

	it('raises a 500 when the shopOwner did not exist', async () => {
		mockUpdate(0)

		await expect(funShopOwnerDelete(_id)).rejects.toThrow('Internal Server Error')
	})
})

describe('funShopOwnerUpdate', () => {
	beforeEach(() => updateOne.mockReset())

	it('replaces the whole personalData sub-document', async () => {
		mockUpdate(1)

		await expect(funShopOwnerUpdate(_id, personalData)).resolves.toBeUndefined()

		expect(updateOne).toHaveBeenCalledExactlyOnceWith({ _id }, { $set: { personalData } })
	})

	// modifiedCount is 0 both when nothing matched and when the update was a no-op, so an
	// unchanged personalData is reported as a failure. Pinned as current behaviour.
	it('raises a 500 when nothing was modified', async () => {
		mockUpdate(0)

		await expect(funShopOwnerUpdate(_id, personalData)).rejects.toThrow('Internal Server Error')
	})
})

describe('funShopOwnerUpdateEmail', () => {
	beforeEach(() => updateOne.mockReset())

	it('writes the dotted login.email path, leaving the rest of login alone', async () => {
		mockUpdateMatched(1)

		await expect(funShopOwnerUpdateEmail(_id, 'updated@marketplace.test')).resolves.toBeUndefined()

		// Dotted, not `{ login: { email } }` — the nested form replaces the whole sub-document and would
		// drop firstLogin, lastLogin, rememberMe and the onboarding fields with it.
		expect(updateOne).toHaveBeenCalledExactlyOnceWith({ _id }, { $set: { 'login.email': 'updated@marketplace.test' } })
	})

	// The address is the collection's one unique index, so this is the only write on the shopOwner
	// that a *valid* input can still fail — hence the 409 rather than a 500 through the generic handler.
	it('turns the unique-index violation into a 409 naming the field', async () => {
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(duplicateKeyError()) })

		expect(await rejection(funShopOwnerUpdateEmail(_id, 'presa@marketplace.test'))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'email: address already registered by another shopOwner'
		})
	})

	// Anything that is not 11000 is a real database failure and must reach Sentry as itself, not be
	// relabelled "already taken" because it happened to arrive through the same catch.
	it('rethrows any other driver error untouched', async () => {
		const broken = Object.assign(new Error('connessione persa'), { code: 'ECONNRESET' })
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(broken) })

		await expect(funShopOwnerUpdateEmail(_id, 'updated@marketplace.test')).rejects.toBe(broken)
	})

	it('raises a 404 when no shopOwner carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funShopOwnerUpdateEmail(_id, 'updated@marketplace.test'))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'shopOwner not found'
		})
	})
})

describe('funShopOwnerUpdateStatus', () => {
	beforeEach(() => updateOne.mockReset())

	// The whole point of the helper: true stores the flag, false removes it. All four combinations are
	// listed because the two flags are independent and each branch is its own `if`.
	it.each([
		[true, true, { disabled: true, waitApprov: true }, {}],
		[true, false, { disabled: true }, { waitApprov: 1 }],
		[false, true, { waitApprov: true }, { disabled: 1 }],
		[false, false, {}, { disabled: 1, waitApprov: 1 }]
	])('disabled=%s waitApprov=%s sets %o and unsets %o', async (disabled, waitApprov, set, unset) => {
		mockUpdateMatched(1)

		await expect(funShopOwnerUpdateStatus(_id, disabled, waitApprov)).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update: { $set: set, $unset: unset } })
	})

	// A flag re-set to the value it already held matches without modifying, and that is a success here —
	// the divergence from funShopOwnerUpdate's `modifiedCount !== 1` 500 above is deliberate.
	it('accepts a write that changed nothing, as long as the document exists', async () => {
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 0 }) })

		await expect(funShopOwnerUpdateStatus(_id, true, true)).resolves.toBeUndefined()
	})

	it('raises a 404 when no shopOwner carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funShopOwnerUpdateStatus(_id, true, true))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'shopOwner not found'
		})
	})
})

describe('funShopOwnerUpdateNote', () => {
	beforeEach(() => updateOne.mockReset())

	// Top level, not inside `personalData`: the path carries no prefix, unlike the three login
	// preferences below. The note is what an operator wrote *about* the account.
	it('stores a note at the root of the document', async () => {
		mockUpdateMatched(1)

		await expect(funShopOwnerUpdateNote(_id, 'Richiamare a settembre')).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update: { $set: { notes: 'Richiamare a settembre' } } })
	})

	// The empty string removes the field rather than storing `''`, exactly as `false` removes a flag in
	// funShopOwnerUpdateStatus above: the collection makes `notes` optional, so "no note" already has
	// one spelling and a stored empty string would give it a second. `$set` must be absent from the
	// update, not present holding nothing — the two are different commands to the driver.
	it('unsets the note when it is cleared', async () => {
		mockUpdateMatched(1)

		await expect(funShopOwnerUpdateNote(_id, '')).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update: { $unset: { notes: 1 } } })
	})

	// `matchedCount`, like the two helpers above and unlike funShopOwnerUpdate: re-saving the note
	// an account already carries is the state the operator asked for, not a failure.
	it('accepts a write that changed nothing, as long as the document exists', async () => {
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 0 }) })

		await expect(funShopOwnerUpdateNote(_id, 'invariata')).resolves.toBeUndefined()
	})

	it('raises a 404 when no shopOwner carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funShopOwnerUpdateNote(_id, 'x'))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'shopOwner not found'
		})
	})
})

describe('funShopOwnerUpdatePreferences', () => {
	beforeEach(() => updateOne.mockReset())

	// Every path is prefixed `login.`: these three live inside the login sub-document, not at the root.
	// Both booleans are stored as they are — false included — unlike the two status flags above.
	it.each([
		[true, true, 'DATI', { 'login.rememberMe': true, 'login.onboardingDone': true, 'login.onboardingStep': 'DATI' }, {}],
		[false, false, 'PV', { 'login.rememberMe': false, 'login.onboardingDone': false, 'login.onboardingStep': 'PV' }, {}],
		[true, false, undefined, { 'login.rememberMe': true, 'login.onboardingDone': false }, { 'login.onboardingStep': 1 }]
	])('rememberMe=%s onboardingDone=%s step=%s sets %o and unsets %o', async (rememberMe, onboardingDone, step, set, unset) => {
		mockUpdateMatched(1)

		await expect(funShopOwnerUpdatePreferences(_id, rememberMe, onboardingDone, step)).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update: { $set: set, $unset: unset } })
	})

	it('raises a 404 when no shopOwner carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funShopOwnerUpdatePreferences(_id, true, true, 'DATI'))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'shopOwner not found'
		})
	})
})

describe('shopOwnersStatsDb', () => {
	it('counts every shopOwner, deleted ones included', async () => {
		countDocuments.mockResolvedValueOnce(7)

		await expect(shopOwnersStatsDb()).resolves.toBe(7)
		expect(countDocuments).toHaveBeenCalledExactlyOnceWith()
	})
})
