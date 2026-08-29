import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const updateOne = vi.fn()
const countDocuments = vi.fn()
const companyFind = vi.fn()
const companyUpdateMany = vi.fn()
const itemUpdateMany = vi.fn()

/**
 * `vi.hoisted`, unlike the plain consts above, because this file imports `mongoose` itself: the mock
 * factory runs while that import is evaluated, which is before any top-level `const` here has been
 * initialised. Same shape as `catalogueLib.test.mts`. The stand-in `withTransaction` runs the work it is
 * handed exactly once — nothing in this file needs the retry a real one performs on a `WriteConflict`.
 */
const { endSession, session, startSession } = vi.hoisted(() => {
	const endSessionFn = vi.fn()
	const sessionObj = {
		withTransaction: vi.fn(async (work: () => Promise<void>) => await work()),
		endSession: endSessionFn
	}

	return { endSession: endSessionFn, session: sessionObj, startSession: vi.fn(async () => sessionObj) }
})

vi.mock('mongoose', async (importOriginal) => {
	const actual = await importOriginal<typeof import('mongoose')>()

	return { ...actual, default: { ...actual.default, startSession } }
})

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { updateOne, countDocuments }
}))

// ⚠️ Neither cascade mock carries `deleteOne` or `updateOne`, for the reason `companyLib.test.mts` leaves
// them off: the storefront cascade withdraws documents, it never removes them and never touches one at a
// time, so a regression to either shape throws here rather than against a real database.
vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind, updateMany: companyUpdateMany }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({
	Item: { updateMany: itemUpdateMany }
}))

const { funShopOwnerDelete } = await import('../src/lib/shopOwner/funShopOwnerDelete.mts')
const { funShopOwnerUpdate } = await import('../src/lib/shopOwner/funShopOwnerUpdate.mts')
const { funShopOwnerUpdateEmail } = await import('../src/lib/shopOwner/funShopOwnerUpdateEmail.mts')
const { funShopOwnerUpdatePreferences } = await import('../src/lib/shopOwner/funShopOwnerUpdatePreferences.mts')
const { funShopOwnerUpdateNote } = await import('../src/lib/shopOwner/funShopOwnerUpdateNote.mts')
const { funShopOwnerUpdateStatus } = await import('../src/lib/shopOwner/funShopOwnerUpdateStatus.mts')
const { default: shopOwnersStatsDb } = await import('../src/lib/shopOwner/shopOwnersStatsDb.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** The admin taking the decision — `ctx.state.user._id` at the resolver, never a wire argument. */
const adminId = new Types.ObjectId('507f1f77bcf86cd799439099')

/** Two shops under the owner, so the item hop has a real `$in` rather than a degenerate one. */
const shopIds = [new Types.ObjectId('507f1f77bcf86cd7994390a1'), new Types.ObjectId('507f1f77bcf86cd7994390a2')]

const personalData = {
	firstName: 'Mark',
	lastName: 'Rivers',
	address: { street: '1 Main Street', postalCode: '02109', city: 'Boston', province: 'MA', country: 'US' }
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

/**
 * As above, for the two helpers that write inside a transaction: their `updateOne` runs `.session(s)`
 * before `.exec()`, and `threaded` collects what each query was handed.
 *
 * A source line that drops the `.session()` reaches for an `.exec()` this mock does not have and fails
 * here, rather than committing on its own outside the transaction it was meant to join.
 */
const threaded: unknown[] = []

const sessioned = (tail: object) => ({
	session: vi.fn((clientSession: unknown) => {
		threaded.push(clientSession)

		return tail
	})
})

function mockUpdateInSession(matchedCount: number) {
	updateOne.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount, modifiedCount: 0 }) }))
}

/** The storefront cascade's three queries, armed with the companies the owner holds. */
function mockCascade(...ids: Types.ObjectId[]) {
	companyFind.mockReturnValueOnce(sessioned({ lean: vi.fn().mockResolvedValue(ids.map((idCompany) => ({ _id: idCompany }))) }))
	companyUpdateMany.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount: ids.length }) }))
	itemUpdateMany.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount: 0 }) }))
}

/** The session the transactional paths open, as the cascade receives it — the mock is not a `ClientSession`. */
const inSession = session as never

/** Every cascade query ran, in order, against the ids handed to `mockCascade`. */
function expectCascade(ids: Types.ObjectId[]) {
	expect(companyFind).toHaveBeenCalledExactlyOnceWith({ idShopOwner: _id }, '_id')
	expect(companyUpdateMany).toHaveBeenCalledExactlyOnceWith({ idShopOwner: _id }, { $set: { published: false } })
	expect(itemUpdateMany).toHaveBeenCalledExactlyOnceWith({ idCompany: trusted({ $in: ids }) }, { $set: { published: false } })
	expect(threaded).toEqual([inSession, inSession, inSession, inSession])
}

/** Nothing was withdrawn — the shape the release path and every refusal have to keep. */
function expectNoCascade() {
	expect(companyFind).not.toHaveBeenCalled()
	expect(companyUpdateMany).not.toHaveBeenCalled()
	expect(itemUpdateMany).not.toHaveBeenCalled()
}

const cascadeMocks = [companyFind, companyUpdateMany, itemUpdateMany]

/** The state every transactional describe starts from: no armed chains, no recorded sessions. */
function resetTransactional() {
	updateOne.mockReset()
	cascadeMocks.forEach((mock) => mock.mockReset())
	endSession.mockClear()
	threaded.length = 0
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
	beforeEach(resetTransactional)

	// Soft delete: the document stays, `deleted` gets a timestamp and the approval flag is dropped
	// so a deleted shopOwner cannot reappear in the "waiting for approval" queue.
	it('stamps deleted and clears waitApprov', async () => {
		mockUpdateInSession(1)
		mockCascade(...shopIds)

		await expect(funShopOwnerDelete(_id, adminId)).resolves.toBeUndefined()

		const { filter, update } = updateArgs()
		expect(filter).toEqual({ _id, deleted: trusted({ $exists: false }) })
		expect(update.$unset).toEqual({ waitApprov: 1 })
		expect(update.$set.deleted).toBeInstanceOf(Date)
	})

	// ADR-044: `deletedBy` is what tells an admin closure apart from a self-service one, and the
	// distinction is carried by the field's presence rather than by any value naming a collection.
	it('records the admin who closed the account', async () => {
		mockUpdateInSession(1)
		mockCascade()

		await expect(funShopOwnerDelete(_id, adminId)).resolves.toBeUndefined()

		expect(updateArgs().update.$set.deletedBy).toBe(adminId)
	})

	// ADR-045: the storefront goes dark with the account, in the same transaction as the stamp.
	it('withdraws every company and every item the owner holds', async () => {
		mockUpdateInSession(1)
		mockCascade(...shopIds)

		await expect(funShopOwnerDelete(_id, adminId)).resolves.toBeUndefined()

		expectCascade(shopIds)
	})

	/*
	 * ⚠️ **The clock starts once.** `deleted` is what the retention sweep measures from and what ADR-046
	 * turns into an undo window, so a second closure over the same document would push the scrub thirty
	 * days further out and quietly postpone the erasure the first one promised. The `$exists: false`
	 * clause is what stops it, and a 404 is the honest answer: the account is already gone.
	 */
	it('refuses an account that is already closed rather than resetting its retention clock', async () => {
		mockUpdateInSession(0)

		expect(await rejection(funShopOwnerDelete(_id, adminId))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'shopOwner not found'
		})

		expectNoCascade()
	})

	it('closes the session even when the write refused', async () => {
		mockUpdateInSession(0)

		await rejection(funShopOwnerDelete(_id, adminId))

		expect(endSession).toHaveBeenCalledOnce()
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
	beforeEach(resetTransactional)

	/** The status write as the resolver makes it, with only what a case cares about spelled out. */
	const status = (over: Partial<Parameters<typeof funShopOwnerUpdateStatus>[0]>) =>
		funShopOwnerUpdateStatus({ _id, disabled: false, waitApprov: false, adminId, ...over })

	/*
	 * The whole point of the helper: true stores the flag, false removes it. All four combinations are
	 * listed because the two flags are independent and each branch is its own `if`.
	 *
	 * ⚠️ **The three `disabled*` fields move as one** (ADR-044). A suspension carries its actor and its
	 * reason; a release clears all three, because a stale reason standing beside a live account is worse
	 * than none and nothing here keeps a history.
	 */
	it.each([
		[true, true, { disabled: true, disabledBy: adminId, disabledReason: 'Fraud report', waitApprov: true }, {}],
		[true, false, { disabled: true, disabledBy: adminId, disabledReason: 'Fraud report' }, { waitApprov: 1 }],
		[false, true, { waitApprov: true }, { disabled: 1, disabledBy: 1, disabledReason: 1 }],
		[false, false, {}, { disabled: 1, disabledBy: 1, disabledReason: 1, waitApprov: 1 }]
	])('disabled=%s waitApprov=%s sets %o and unsets %o', async (disabled, waitApprov, set, unset) => {
		mockUpdateInSession(1)
		if (disabled) mockCascade(...shopIds)

		await expect(
			status({ disabled, waitApprov, disabledReason: disabled ? 'Fraud report' : undefined })
		).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update: { $set: set, $unset: unset } })
	})

	// ADR-045: suspending takes the storefront off air, in the same transaction as the flag.
	it('withdraws every company and every item when the owner is suspended', async () => {
		mockUpdateInSession(1)
		mockCascade(...shopIds)

		await expect(status({ disabled: true, disabledReason: 'Fraud report' })).resolves.toBeUndefined()

		expectCascade(shopIds)
	})

	/*
	 * ⚠️ **Releasing puts nothing back, and this is the assertion that keeps it that way.** Republishing
	 * what was withdrawn is the obvious symmetry and a direct contradiction of the platform owner's ruling
	 * — *"restoring a shopowner, restore only his account"*. The owner brings their own catalogue back,
	 * with the ShopOwner tier's bulk control, and the platform never guesses which shops were live.
	 */
	it('touches neither company nor item when the suspension is lifted', async () => {
		mockUpdateInSession(1)

		await expect(status({ disabled: false, waitApprov: true })).resolves.toBeUndefined()

		expectNoCascade()
	})

	/*
	 * ⚠️ **`waitApprov` deliberately does not cascade.** Re-gating an owner to awaiting-approval leaves
	 * their shop live, which is arguably the same position a suspension puts them in — but nobody has
	 * asked that question, and ADR-045 records that answering it by analogy is how the gap it closes was
	 * created. Pinned here so a later change to the rule is a change to this test.
	 */
	it('leaves the storefront up when only the approval gate is raised', async () => {
		mockUpdateInSession(1)

		await expect(status({ waitApprov: true })).resolves.toBeUndefined()

		expectNoCascade()
	})

	// A flag re-set to the value it already held matches without modifying, and that is a success here —
	// the divergence from funShopOwnerUpdate's `modifiedCount !== 1` 500 above is deliberate.
	it('accepts a write that changed nothing, as long as the document exists', async () => {
		mockUpdateInSession(1)
		mockCascade(...shopIds)

		await expect(status({ disabled: true, waitApprov: true, disabledReason: 'Fraud report' })).resolves.toBeUndefined()
	})

	// The 404 is raised inside the transaction, which is what stops a cascade running over an id that
	// matched nothing — an owner who does not exist must not have somebody's shops withdrawn on their behalf.
	it('raises a 404 when no shopOwner carries that id, and withdraws nothing', async () => {
		mockUpdateInSession(0)

		expect(await rejection(status({ disabled: true, waitApprov: true, disabledReason: 'Fraud report' }))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'shopOwner not found'
		})

		expectNoCascade()
		expect(endSession).toHaveBeenCalledOnce()
	})
})

describe('funShopOwnerUpdateNote', () => {
	beforeEach(() => updateOne.mockReset())

	// Top level, not inside `personalData`: the path carries no prefix, unlike the three login
	// preferences below. The note is what an admin wrote *about* the account.
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
	// an account already carries is the state the admin asked for, not a failure.
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
		[true, true, 'DATA', { 'login.rememberMe': true, 'login.onboardingDone': true, 'login.onboardingStep': 'DATA' }, {}],
		[false, false, 'PV', { 'login.rememberMe': false, 'login.onboardingDone': false, 'login.onboardingStep': 'PV' }, {}],
		[true, false, undefined, { 'login.rememberMe': true, 'login.onboardingDone': false }, { 'login.onboardingStep': 1 }]
	])('rememberMe=%s onboardingDone=%s step=%s sets %o and unsets %o', async (rememberMe, onboardingDone, step, set, unset) => {
		mockUpdateMatched(1)

		await expect(funShopOwnerUpdatePreferences(_id, rememberMe, onboardingDone, step)).resolves.toBeUndefined()

		expect(updateArgs()).toEqual({ filter: { _id }, update: { $set: set, $unset: unset } })
	})

	it('raises a 404 when no shopOwner carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funShopOwnerUpdatePreferences(_id, true, true, 'DATA'))).toEqual({
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
