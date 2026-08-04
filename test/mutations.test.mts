import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const create = vi.fn()
const funShopOwnerDelete = vi.fn()
const funShopOwnerUpdate = vi.fn()
const funShopOwnerUpdateEmail = vi.fn()
const funShopOwnerUpdateNote = vi.fn()
const funShopOwnerUpdatePreferences = vi.fn()
const funShopOwnerUpdateStatus = vi.fn()
const funCompanyAdd = vi.fn()
const funCompanyDelete = vi.fn()
const funCompanyUpdate = vi.fn()
const funAdminUpdatePwd = vi.fn()
const captureException = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner', () => ({ ShopOwner: { create } }))
vi.mock('@lib/shopOwner/funShopOwnerDelete.mjs', () => ({ funShopOwnerDelete }))
vi.mock('@lib/shopOwner/funShopOwnerUpdate.mjs', () => ({ funShopOwnerUpdate }))
vi.mock('@lib/shopOwner/funShopOwnerUpdateEmail.mjs', () => ({ funShopOwnerUpdateEmail }))
vi.mock('@lib/shopOwner/funShopOwnerUpdateNote.mjs', () => ({ funShopOwnerUpdateNote }))
vi.mock('@lib/shopOwner/funShopOwnerUpdatePreferences.mjs', () => ({ funShopOwnerUpdatePreferences }))
vi.mock('@lib/shopOwner/funShopOwnerUpdateStatus.mjs', () => ({ funShopOwnerUpdateStatus }))
vi.mock('@lib/company/funCompanyAdd.mjs', () => ({ funCompanyAdd }))
vi.mock('@lib/company/funCompanyDelete.mjs', () => ({ funCompanyDelete }))
vi.mock('@lib/company/funCompanyUpdate.mjs', () => ({ funCompanyUpdate }))
vi.mock('@lib/admin/funAdminUpdatePwd.mjs', () => ({ funAdminUpdatePwd }))
// tryCatchRethrow is NOT mocked — the point of these tests is that a failure really travels
// through it. Only its Sentry sink is stubbed.
//
// The `@lib/validate/*` modules are NOT mocked either, and that is the same decision one layer down:
// the mutations' contract with them is that a bad field never reaches the database and a good one
// arrives normalised, which a stub asserts nothing about.
vi.mock('@sentry/node', () => ({ captureException }))

const { adminUpdatePwd } = await import('../src/graphQLApi/schema/mutations/adminUpdatePwd.mts')
const { companyAdd } = await import('../src/graphQLApi/schema/mutations/companyAdd.mts')
const { companyDel } = await import('../src/graphQLApi/schema/mutations/companyDel.mts')
const { companyUpdate } = await import('../src/graphQLApi/schema/mutations/companyUpdate.mts')
const { shopOwnerAdd } = await import('../src/graphQLApi/schema/mutations/shopOwnerAdd.mts')
const { shopOwnerDel } = await import('../src/graphQLApi/schema/mutations/shopOwnerDel.mts')
const { shopOwnerUpdate } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdate.mts')
const { shopOwnerUpdateEmail } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdateEmail.mts')
const { shopOwnerUpdateNote } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdateNote.mts')
const { shopOwnerUpdatePreferences } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdatePreferences.mts')
const { shopOwnerUpdateStatus } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdateStatus.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
const login = { email: 'shop@marketplace.test', password: 'clear' } as never
const ctx = { state: { user: { _id, email: 'operator@marketplace.test' } } } as never

/**
 * A complete, already-valid personalData.
 *
 * It has to be complete now that `shopOwnerUpdate` validates before writing — the two-field stub
 * this used to be is rejected at `birth.date` before the resolver reaches the lib, which is the
 * validator doing its job and not a fixture worth keeping.
 */
const personalDataFields = {
	firstName: 'Mario',
	lastName: 'Rossi',
	birth: { date: new Date('1990-05-17T00:00:00.000Z') },
	address: { street: 'Via Roma 1', postalCode: '20100', city: 'Milano', province: 'MI' },
	contacts: { mobile: '3331234567', email: 'mario@marketplace.test' }
}

/**
 * The same fixture as the resolver's argument type sees it.
 *
 * Two names for one object because the argument types are `never` — the resolvers take the GraphQL
 * input types and nothing here builds one — and `never` cannot be spread. The tests that pass the
 * fixture whole use this; the ones that override a field spread `personalDataFields`.
 */
const personalData = personalDataFields as never

const address = {
	street: 'Via Milano 9',
	postalCode: '20100',
	city: 'Milano',
	province: 'MI',
	position: { coordinates: [9.19, 45.46] }
} as never

/** A complete, already-valid company, as `GraphQLInputCompany` delivers it — seat included. */
const company = {
	legalName: 'Pizzeria da Mario S.r.l.',
	vatNumber: '12345678901',
	taxCode: '12345678901',
	contactPerson: 'Mario Rossi',
	administrator: 'Mario Rossi',
	uniqueCode: 'ABC1234',
	certifiedEmail: 'pizzeria@pec.test',
	address,
	registryExtract: 'registryExtract-2026'
} as never

describe('adminUpdatePwd', () => {
	beforeEach(() => {
		funAdminUpdatePwd.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// The account changed is the one the request is authenticated as. There is no `_id` argument to
	// pass, and there must not be: every operator authenticates against the same collection and the
	// platform has no role field, so a client-supplied id would turn this into "change any
	// operator's password". The assertion is that the id comes off ctx.state.user, which is written
	// by the Redis session lookup in the auth middleware and is not reachable from the request body.
	it('changes the password of the session account and answers true', async () => {
		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'oldpwd12345', passwordNew: 'newpwd12345' }, ctx)).resolves.toBe(
			true
		)

		expect(funAdminUpdatePwd).toHaveBeenCalledExactlyOnceWith(_id, 'oldpwd12345', 'newpwd12345')
	})

	// A rejected old password must reach the client as the 401 the lib raised, not be flattened into
	// a generic 500 — and must not be reported to Sentry, since it is a normal outcome.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwUnauthorizedError } = await import('@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError')
		funAdminUpdatePwd.mockImplementationOnce(() => throwUnauthorizedError())

		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'oldpwd12345', passwordNew: 'newpwd12345' }, ctx)).rejects.toThrow(
			'Unauthorized'
		)
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('mongo down')
		funAdminUpdatePwd.mockRejectedValueOnce(error)

		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'oldpwd12345', passwordNew: 'newpwd12345' }, ctx)).rejects.toThrow(
			'Internal Server Error'
		)
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('shopOwnerAdd', () => {
	beforeEach(() => {
		create.mockReset().mockResolvedValue({ _id })
		captureException.mockReset()
	})

	// registeredAt is stamped server-side, never taken from the client.
	it('creates the shopOwner and answers true', async () => {
		await expect(shopOwnerAdd.resolve(null, { login, personalData })).resolves.toBe(true)

		const [doc] = create.mock.calls[0]
		expect(doc.login).toBe(login)
		// `toEqual`, not `toBe`: the personalData written is the validator's return value, a new object.
		// It is deliberately not the argument — see the normalisation test below.
		expect(doc.personalData).toEqual(personalData)
		expect(doc.registeredAt).toBeInstanceOf(Date)
	})

	// Same contract `shopOwnerUpdate` has, and it has to be the same: both mutations take the one
	// shared input type, so anything the update path normalises can arrive here too. Untrimmed text is
	// trimmed, a lower-case province is upper-cased, a blank landline is dropped from the object
	// rather than written as null, and the address point — which the client sends as coordinates only
	// — gets the `type: 'Point'` the collection requires.
	it('normalises the personalData before it is written', async () => {
		await expect(
			shopOwnerAdd.resolve(null, {
				login,
				personalData: {
					...personalDataFields,
					firstName: '  Mario  ',
					address: { ...personalDataFields.address, province: 'mi', position: { coordinates: [9.19, 45.46] } },
					contacts: { ...personalDataFields.contacts, landline: '   ' }
				} as never
			})
		).resolves.toBe(true)

		const [doc] = create.mock.calls[0]
		expect(doc.personalData.firstName).toBe('Mario')
		expect(doc.personalData.address.province).toBe('MI')
		expect(doc.personalData.address.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
		expect('landline' in doc.personalData.contacts).toBe(false)
	})

	// The validator raising is a 400 the operator can act on, and it must not reach `create` at all —
	// nor Sentry, which is for bugs and not for a mistyped form.
	it('refuses an invalid personalData without touching the database', async () => {
		expect(
			await rejection(shopOwnerAdd.resolve(null, { login, personalData: { ...personalDataFields, firstName: '   ' } as never }))
		).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'firstName: field required'
		})

		expect(create).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports a driver failure to Sentry and answers a generic 500', async () => {
		const error = new Error('duplicate key')
		create.mockRejectedValueOnce(error)

		await expect(shopOwnerAdd.resolve(null, { login, personalData })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('shopOwnerDel', () => {
	beforeEach(() => {
		funShopOwnerDelete.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('soft-deletes the shopOwner and answers true', async () => {
		await expect(shopOwnerDel.resolve(null, { _id })).resolves.toBe(true)
		expect(funShopOwnerDelete).toHaveBeenCalledExactlyOnceWith(_id)
	})

	it('propagates the failure', async () => {
		funShopOwnerDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(shopOwnerDel.resolve(null, { _id })).rejects.toThrow('Internal Server Error')
	})
})

describe('shopOwnerUpdate', () => {
	beforeEach(() => {
		funShopOwnerUpdate.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('updates the personalData and answers true', async () => {
		await expect(shopOwnerUpdate.resolve(null, { _id, personalData })).resolves.toBe(true)
		expect(funShopOwnerUpdate).toHaveBeenCalledExactlyOnceWith(_id, personalData)
	})

	// `toEqual`, and a fixture that is deliberately messy: the resolver passes on the validator's
	// **return value**, not its argument, so this is the assertion that would fail if someone
	// "simplified" it back to `validateShopOwnerPersonalData(...); await fun(_id, args.personalData)`.
	// A cleared `landline` must be gone from the object rather than present holding undefined — the
	// collection validator rejects the whole write otherwise.
	it('writes the normalised personalData, not the one that arrived', async () => {
		await expect(
			shopOwnerUpdate.resolve(null, {
				_id,
				personalData: {
					...personalDataFields,
					firstName: '  Mario  ',
					address: { street: 'Via Roma 1', postalCode: '20100', city: 'Milano', province: 'mi' },
					contacts: { mobile: '3331234567', landline: '   ', email: 'mario@marketplace.test' }
				} as never
			})
		).resolves.toBe(true)

		const [, written] = funShopOwnerUpdate.mock.calls[0]
		expect(written.firstName).toBe('Mario')
		expect(written.address.province).toBe('MI')
		expect(Object.keys(written.contacts)).toEqual(['mobile', 'email'])
	})

	// The 400 has to happen *before* the write, not be reported after one — an shopOwner whose
	// personalData was replaced by a rejected one is exactly the failure the validator exists to stop.
	it('rejects an invalid personalData with a 400 and never reaches the database', async () => {
		const outcome = await rejection(
			shopOwnerUpdate.resolve(null, {
				_id,
				personalData: {
					...personalDataFields,
					address: { ...personalDataFields.address, postalCode: '2010' }
				} as never
			})
		)

		expect(outcome).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'address.postalCode: the postal code is 5 digits'
		})
		expect(funShopOwnerUpdate).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	// A GraphQLError raised deeper down keeps its own status instead of being flattened to 500 —
	// that branch of tryCatchRethrow is only reachable through a resolver like this one.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwAccessTokenExpiredOrDeleted } =
			await import('@axiumine/koa-utils/graphQL/throw/throwAccessTokenExpiredOrDeleted')
		funShopOwnerUpdate.mockImplementationOnce(() => throwAccessTokenExpiredOrDeleted())

		await expect(shopOwnerUpdate.resolve(null, { _id, personalData })).rejects.toThrow('Invalid Token')
		expect(captureException).not.toHaveBeenCalled()
	})
})

describe('shopOwnerUpdateEmail', () => {
	beforeEach(() => {
		funShopOwnerUpdateEmail.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('trims the address before storing it', async () => {
		await expect(shopOwnerUpdateEmail.resolve(null, { _id, email: '  updated@marketplace.test ' })).resolves.toBe(true)
		expect(funShopOwnerUpdateEmail).toHaveBeenCalledExactlyOnceWith(_id, 'updated@marketplace.test')
	})

	it('refuses a malformed address without touching the database', async () => {
		expect(await rejection(shopOwnerUpdateEmail.resolve(null, { _id, email: 'updated@marketplace' }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'email: invalid email address'
		})

		expect(funShopOwnerUpdateEmail).not.toHaveBeenCalled()
	})

	// The collision is a 409 the operator can act on, not a 500 — and it must not page anyone.
	it('passes a duplicate-address conflict through with its own status', async () => {
		const { throwAlreadyTakenError } = await import('@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError')
		funShopOwnerUpdateEmail.mockImplementationOnce(() => throwAlreadyTakenError('email: già registrata'))

		expect(await rejection(shopOwnerUpdateEmail.resolve(null, { _id, email: 'updated@marketplace.test' }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'email: già registrata'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('mongo down')
		funShopOwnerUpdateEmail.mockRejectedValueOnce(error)

		await expect(shopOwnerUpdateEmail.resolve(null, { _id, email: 'updated@marketplace.test' })).rejects.toThrow(
			'Internal Server Error'
		)
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('shopOwnerUpdateStatus', () => {
	beforeEach(() => {
		funShopOwnerUpdateStatus.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// Both flags travel exactly as sent — `false` is a value here, not an omission, which is why the
	// arguments are non-null in the schema.
	it.each([
		[true, true],
		[true, false],
		[false, true],
		[false, false]
	])('forwards disabled=%s waitApprov=%s unchanged', async (disabled, waitApprov) => {
		await expect(shopOwnerUpdateStatus.resolve(null, { _id, disabled, waitApprov })).resolves.toBe(true)
		expect(funShopOwnerUpdateStatus).toHaveBeenCalledExactlyOnceWith(_id, disabled, waitApprov)
	})

	it('propagates the failure', async () => {
		funShopOwnerUpdateStatus.mockRejectedValueOnce(new Error('mongo down'))

		await expect(shopOwnerUpdateStatus.resolve(null, { _id, disabled: true, waitApprov: false })).rejects.toThrow(
			'Internal Server Error'
		)
	})
})

describe('shopOwnerUpdateNote', () => {
	beforeEach(() => {
		funShopOwnerUpdateNote.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('trims the note before storing it', async () => {
		await expect(shopOwnerUpdateNote.resolve(null, { _id, notes: '  Richiamare a settembre  ' })).resolves.toBe(true)
		expect(funShopOwnerUpdateNote).toHaveBeenCalledExactlyOnceWith(_id, 'Richiamare a settembre')
	})

	// The empty string is a value here, not an omission: it is how the operator clears the note, and
	// the lib turns it into an `$unset`. A box holding only spaces means the same thing and has to
	// arrive the same way — the argument is `String!` precisely so this state has one spelling.
	it.each([[''], ['   '], ['\n\t']])('passes %p through as the clear instruction', async (note) => {
		await expect(shopOwnerUpdateNote.resolve(null, { _id, notes: note })).resolves.toBe(true)
		expect(funShopOwnerUpdateNote).toHaveBeenCalledExactlyOnceWith(_id, '')
	})

	// The collection caps `notes` at 2000. Over that the write would be rejected by MongoDB as a 500
	// with nothing the operator could act on, so the 400 has to be raised here, before the database.
	it('refuses a note past the collection bound without touching the database', async () => {
		expect(await rejection(shopOwnerUpdateNote.resolve(null, { _id, notes: 'N'.repeat(2001) }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'notes: max 2000 characters'
		})

		expect(funShopOwnerUpdateNote).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	it('accepts a note exactly at the bound', async () => {
		await expect(shopOwnerUpdateNote.resolve(null, { _id, notes: 'N'.repeat(2000) })).resolves.toBe(true)
		expect(funShopOwnerUpdateNote).toHaveBeenCalledExactlyOnceWith(_id, 'N'.repeat(2000))
	})

	it('propagates the failure', async () => {
		funShopOwnerUpdateNote.mockRejectedValueOnce(new Error('mongo down'))

		await expect(shopOwnerUpdateNote.resolve(null, { _id, notes: 'x' })).rejects.toThrow('Internal Server Error')
	})
})

describe('shopOwnerUpdatePreferences', () => {
	beforeEach(() => {
		funShopOwnerUpdatePreferences.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('trims the onboarding step', async () => {
		await expect(
			shopOwnerUpdatePreferences.resolve(null, { _id, rememberMe: true, onboardingDone: false, onboardingStep: ' 3 ' })
		).resolves.toBe(true)

		expect(funShopOwnerUpdatePreferences).toHaveBeenCalledExactlyOnceWith(_id, true, false, '3')
	})

	// `null`, `undefined` and a box holding only spaces are one state — "not set" — and all three have
	// to arrive as `undefined`, because that is what the lib turns into an `$unset`. `null` reaches the
	// collection as a value of the wrong type for a `string` property and fails the whole write.
	it.each([[null], [undefined], ['   ']])('treats %p as no step at all', async (onboardingStep) => {
		await expect(
			shopOwnerUpdatePreferences.resolve(null, { _id, rememberMe: false, onboardingDone: true, onboardingStep })
		).resolves.toBe(true)

		expect(funShopOwnerUpdatePreferences).toHaveBeenCalledExactlyOnceWith(_id, false, true, undefined)
	})

	it('refuses a step longer than the collection allows', async () => {
		const outcome = await rejection(
			shopOwnerUpdatePreferences.resolve(null, { _id, rememberMe: true, onboardingDone: true, onboardingStep: '12345' })
		)

		expect(outcome).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'onboardingStep: max 4 characters'
		})
		expect(funShopOwnerUpdatePreferences).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funShopOwnerUpdatePreferences.mockRejectedValueOnce(new Error('mongo down'))

		await expect(
			shopOwnerUpdatePreferences.resolve(null, { _id, rememberMe: true, onboardingDone: true, onboardingStep: '2' })
		).rejects.toThrow('Internal Server Error')
	})
})

describe('companyAdd', () => {
	beforeEach(() => {
		funCompanyAdd.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// Two peculiarities: the owner is an argument, because the session is the operator's, and the seat's
	// `position.type` is stamped by the validator rather than sent.
	it('creates the company under the shopOwner it was given, normalised', async () => {
		await expect(companyAdd.resolve(null, { idShopOwner: _id, company })).resolves.toBe(true)

		const [owner, data] = funCompanyAdd.mock.calls[0]
		expect(owner).toBe(_id)
		expect(data.legalName).toBe('Pizzeria da Mario S.r.l.')
		expect(data.address.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	})

	it('rejects the whole insert when one field is invalid', async () => {
		const outcome = await rejection(
			companyAdd.resolve(null, { idShopOwner: _id, company: { ...(company as object), vatNumber: '123' } as never })
		)

		expect(outcome).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'company.vatNumber: the VAT number is 11 digits'
		})
		expect(funCompanyAdd).not.toHaveBeenCalled()
	})

	// The 409 the lib raises on a duplicate partita IVA is the one an operator can act on, and it must not
	// reach Sentry: a company already registered is a normal outcome, not a platform failure.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwAlreadyTakenError } = await import('@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError')
		funCompanyAdd.mockImplementationOnce(() =>
			throwAlreadyTakenError('VAT number or certified email already registered by another company')
		)

		expect(await rejection(companyAdd.resolve(null, { idShopOwner: _id, company }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'VAT number or certified email already registered by another company'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funCompanyAdd.mockRejectedValueOnce(new Error('mongo down'))

		await expect(companyAdd.resolve(null, { idShopOwner: _id, company })).rejects.toThrow('Internal Server Error')
	})
})

describe('companyUpdate', () => {
	beforeEach(() => {
		funCompanyUpdate.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// ⚠️ No owner, neither as an argument nor inside the input — which is what keeps a company from being
	// handed to another shopOwner, taking its shops with it, by editing its card.
	it('rewrites the company by id, without touching its owner', async () => {
		await expect(companyUpdate.resolve(null, { _id, company })).resolves.toBe(true)

		const [id, data] = funCompanyUpdate.mock.calls[0]
		expect(id).toBe(_id)
		expect('idShopOwner' in data).toBe(false)
		expect(data.address.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	})

	// The seat is validated with the company's own prefix, so the operator is told which of the two
	// addresses on the page is wrong.
	it('rejects the whole save when the seat is invalid', async () => {
		const outcome = await rejection(
			companyUpdate.resolve(null, {
				_id,
				company: { ...(company as object), address: { ...(address as object), postalCode: 'ABCDE' } } as never
			})
		)

		expect(outcome).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'company.address.postalCode: the postal code is 5 digits'
		})
		expect(funCompanyUpdate).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funCompanyUpdate.mockRejectedValueOnce(new Error('mongo down'))

		await expect(companyUpdate.resolve(null, { _id, company })).rejects.toThrow('Internal Server Error')
	})
})

describe('companyDel', () => {
	beforeEach(() => {
		funCompanyDelete.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('deletes the company by id and answers true', async () => {
		await expect(companyDel.resolve(null, { _id })).resolves.toBe(true)

		expect(funCompanyDelete).toHaveBeenCalledExactlyOnceWith(_id)
	})

	// The refusal an operator meets when the company still has shops: a 409 with a message that says what
	// to do about it, and nothing reported to Sentry.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwConflictError } = await import('@axiumine/koa-utils/graphQL/throw/throwConflictError')
		funCompanyDelete.mockImplementationOnce(() => throwConflictError('company ancora collegata a uno o più punti vendita'))

		expect(await rejection(companyDel.resolve(null, { _id }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'company ancora collegata a uno o più punti vendita'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funCompanyDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(companyDel.resolve(null, { _id })).rejects.toThrow('Internal Server Error')
	})
})
