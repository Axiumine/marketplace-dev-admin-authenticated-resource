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
const funUserDelete = vi.fn()
const funUserUpdateStatus = vi.fn()
const funCompanyAdd = vi.fn()
const funCompanyDelete = vi.fn()
const funCompanyUpdate = vi.fn()
const funCompanyUpdatePublished = vi.fn()
const funAdminUpdatePwd = vi.fn()
const endEverySession = vi.fn()
const endEveryShopOwnerSession = vi.fn()
const endEveryUserSession = vi.fn()
const funKeygripRotate = vi.fn()
const funKeygripRetire = vi.fn()
const captureException = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({ ShopOwner: { create } }))
vi.mock('@lib/shopOwner/funShopOwnerDelete.mjs', () => ({ funShopOwnerDelete }))
vi.mock('@lib/shopOwner/funShopOwnerUpdate.mjs', () => ({ funShopOwnerUpdate }))
vi.mock('@lib/shopOwner/funShopOwnerUpdateEmail.mjs', () => ({ funShopOwnerUpdateEmail }))
vi.mock('@lib/shopOwner/funShopOwnerUpdateNote.mjs', () => ({ funShopOwnerUpdateNote }))
vi.mock('@lib/shopOwner/funShopOwnerUpdatePreferences.mjs', () => ({ funShopOwnerUpdatePreferences }))
vi.mock('@lib/shopOwner/funShopOwnerUpdateStatus.mjs', () => ({ funShopOwnerUpdateStatus }))
vi.mock('@lib/user/funUserDelete.mjs', () => ({ funUserDelete }))
vi.mock('@lib/user/funUserUpdateStatus.mjs', () => ({ funUserUpdateStatus }))
vi.mock('@lib/company/funCompanyAdd.mjs', () => ({ funCompanyAdd }))
vi.mock('@lib/company/funCompanyDelete.mjs', () => ({ funCompanyDelete }))
vi.mock('@lib/company/funCompanyUpdate.mjs', () => ({ funCompanyUpdate }))
vi.mock('@lib/company/funCompanyUpdatePublished.mjs', () => ({ funCompanyUpdatePublished }))
vi.mock('@lib/admin/funAdminUpdatePwd.mjs', () => ({ funAdminUpdatePwd }))
// Mocked here, and covered for real in `endEverySession.test.mts`: what this file asserts about it is
// *when* the resolver calls it, which a stub answers exactly as well as a live Redis conversation would.
vi.mock('@lib/auth/endEverySession.mjs', () => ({ endEverySession }))
vi.mock('@lib/auth/endEveryShopOwnerSession.mjs', () => ({ endEveryShopOwnerSession }))
vi.mock('@lib/auth/endEveryUserSession.mjs', () => ({ endEveryUserSession }))
vi.mock('@lib/keygrip/funKeygripRotate.mjs', () => ({ funKeygripRotate }))
vi.mock('@lib/keygrip/funKeygripRetire.mjs', () => ({ funKeygripRetire }))
// tryCatchRethrow is NOT mocked — the point of these tests is that a failure really travels
// through it. Only its Sentry sink is stubbed.
//
// The `@lib/validate/*` modules are NOT mocked either, and that is the same decision one layer down:
// the mutations' contract with them is that a bad field never reaches the database and a good one
// arrives normalised, which a stub asserts nothing about.
vi.mock('@sentry/node', () => ({ captureException }))

const { adminUpdatePwd } = await import('../src/graphQLApi/schema/mutations/adminUpdatePwd.mts')
const { keygripRotate } = await import('../src/graphQLApi/schema/mutations/keygripRotate.mts')
const { keygripRetire } = await import('../src/graphQLApi/schema/mutations/keygripRetire.mts')
const { companyAdd } = await import('../src/graphQLApi/schema/mutations/companyAdd.mts')
const { companyDel } = await import('../src/graphQLApi/schema/mutations/companyDel.mts')
const { companyUpdate } = await import('../src/graphQLApi/schema/mutations/companyUpdate.mts')
const { companyUpdatePublished } = await import('../src/graphQLApi/schema/mutations/companyUpdatePublished.mts')
const { shopOwnerAdd } = await import('../src/graphQLApi/schema/mutations/shopOwnerAdd.mts')
const { shopOwnerDel } = await import('../src/graphQLApi/schema/mutations/shopOwnerDel.mts')
const { shopOwnerUpdate } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdate.mts')
const { shopOwnerUpdateEmail } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdateEmail.mts')
const { shopOwnerUpdateNote } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdateNote.mts')
const { shopOwnerUpdatePreferences } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdatePreferences.mts')
const { shopOwnerUpdateStatus } = await import('../src/graphQLApi/schema/mutations/shopOwnerUpdateStatus.mts')
const { userDel } = await import('../src/graphQLApi/schema/mutations/userDel.mts')
const { userUpdateStatus } = await import('../src/graphQLApi/schema/mutations/userUpdateStatus.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
const login = { email: 'shop@marketplace.test', password: 'clear' } as never
/**
 * The admin the request is authenticated as — deliberately NOT `_id`, which is the account being acted
 * on. Sharing one id between the two would make every "the actor comes off the session" assertion below
 * pass against a resolver that read the actor off the wire instead.
 */
const adminId = new Types.ObjectId('507f1f77bcf86cd799439099')

const ctx = { state: { user: { _id: adminId, email: 'admin@marketplace.test' } } } as never

/**
 * A complete, already-valid personalData.
 *
 * It has to be complete now that `shopOwnerUpdate` validates before writing — the two-field stub
 * this used to be is rejected at `birth.date` before the resolver reaches the lib, which is the
 * validator doing its job and not a fixture worth keeping.
 */
const personalDataFields = {
	firstName: 'Mark',
	lastName: 'Rivers',
	birth: { date: new Date('1990-05-17T00:00:00.000Z') },
	address: { street: '1 Main Street', postalCode: '02109', city: 'Boston', province: 'MA' },
	contacts: { mobile: '3331234567', email: 'mark@marketplace.test' }
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
	street: '9 Harbour Road',
	postalCode: '02109',
	city: 'Boston',
	province: 'MA',
	position: { coordinates: [9.19, 45.46] }
} as never

/** A complete, already-valid company, as `GraphQLInputCompany` delivers it — seat included. */
const company = {
	legalName: 'Marks Boutique Ltd',
	vatNumber: '12345678901',
	taxCode: '12345678901',
	contactPerson: 'Mark Rivers',
	administrator: 'Mark Rivers',
	uniqueCode: 'ABC1234',
	certifiedEmail: 'certified@boutique.test',
	address,
	registryExtract: 'registryExtract-2026'
} as never

describe('adminUpdatePwd', () => {
	beforeEach(() => {
		funAdminUpdatePwd.mockReset().mockResolvedValue(undefined)
		endEverySession.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// The account changed is the one the request is authenticated as. There is no `_id` argument to
	// pass, and there must not be: every admin authenticates against the same collection and the
	// platform has no role field, so a client-supplied id would turn this into "change any
	// admin's password". The assertion is that the id comes off ctx.state.user, which is written
	// by the Redis session lookup in the auth middleware and is not reachable from the request body.
	it('changes the password of the session account and answers true', async () => {
		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'oldpwd12345', passwordNew: 'newpwd12345' }, ctx)).resolves.toBe(
			true
		)

		expect(funAdminUpdatePwd).toHaveBeenCalledExactlyOnceWith(adminId, 'oldpwd12345', 'newpwd12345')
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

	/*
	 * ⚠️ **Every session ends, and only after the write landed.** A password change made because
	 * someone else is believed to be inside the account is the remedy it appears to be only if the
	 * intruder's session dies with it — and on this tier that session reaches every shop owner and every
	 * company. The order is the other half: revoking first would log an admin out of every device for a
	 * change that then failed.
	 */
	it('ends every session the account holds, after the password write', async () => {
		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'oldpwd12345', passwordNew: 'newpwd12345' }, ctx)).resolves.toBe(
			true
		)

		expect(endEverySession).toHaveBeenCalledExactlyOnceWith(ctx)
		expect(endEverySession.mock.invocationCallOrder[0]).toBeGreaterThan(funAdminUpdatePwd.mock.invocationCallOrder[0])
	})

	// The revoke is not attempted when the write did not happen. A wrong current password answers 401 and
	// must not, on its way out, log the admin out of the devices they are legitimately using.
	it('revokes nothing when the password write failed', async () => {
		const { throwUnauthorizedError } = await import('@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError')
		funAdminUpdatePwd.mockImplementationOnce(() => throwUnauthorizedError())

		await rejection(adminUpdatePwd.resolve(null, { passwordOld: 'wrongpwd1234', passwordNew: 'newpwd12345' }, ctx))

		expect(endEverySession).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **A revoke that fails fails the mutation.** The alternative — answering `true` and reporting the
	 * Redis error somewhere else — tells the admin their password change ended every other session when
	 * it did not, which is worse than an error they can retry.
	 */
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEverySession.mockRejectedValueOnce(new Error('redis down'))

		expect(
			await rejection(adminUpdatePwd.resolve(null, { passwordOld: 'oldpwd12345', passwordNew: 'newpwd12345' }, ctx))
		).toMatchObject({ message: 'Internal Server Error', http: { status: 500 } })
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
					firstName: '  Mark  ',
					address: { ...personalDataFields.address, province: 'ma', position: { coordinates: [9.19, 45.46] } },
					contacts: { ...personalDataFields.contacts, landline: '   ' }
				} as never
			})
		).resolves.toBe(true)

		const [doc] = create.mock.calls[0]
		expect(doc.personalData.firstName).toBe('Mark')
		expect(doc.personalData.address.province).toBe('MA')
		expect(doc.personalData.address.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
		expect('landline' in doc.personalData.contacts).toBe(false)
	})

	// The validator raising is a 400 the admin can act on, and it must not reach `create` at all —
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
		endEveryShopOwnerSession.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// ⚠️ **The admin's id comes off `ctx.state.user`, never off the wire** (ADR-044). `deletedBy` beside
	// a `deleted` stamp is what tells an admin closure apart from a self-service one, so an argument a
	// client could set would let any admin sign somebody else's name to their decision.
	it('soft-deletes the shopOwner in the admin name and answers true', async () => {
		await expect(shopOwnerDel.resolve(null, { _id }, ctx)).resolves.toBe(true)
		expect(funShopOwnerDelete).toHaveBeenCalledExactlyOnceWith(_id, adminId)
	})

	it('propagates the failure', async () => {
		funShopOwnerDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(shopOwnerDel.resolve(null, { _id }, ctx)).rejects.toThrow('Internal Server Error')
	})

	/*
	 * ⚠️ **Closing ends every session the owner holds, unconditionally.** Until this the stamp was a label:
	 * `checkUserAuthorizationDisDel` refuses a closed account at the login gate and `findAccountForSession`
	 * re-runs that on every refresh, but neither bites until the next rotation — so a closed owner kept
	 * working for a whole access-token lifetime. Unlike the status mutation there is no "off" to compare
	 * against; a closure has one direction.
	 */
	it('ends every session the owner holds', async () => {
		await expect(shopOwnerDel.resolve(null, { _id }, ctx)).resolves.toBe(true)

		expect(endEveryShopOwnerSession).toHaveBeenCalledExactlyOnceWith(_id)
		expect(endEveryShopOwnerSession.mock.invocationCallOrder[0]).toBeGreaterThan(funShopOwnerDelete.mock.invocationCallOrder[0])
	})

	// Gated on the write: `funShopOwnerDelete` answers 404 when nothing matched — an id naming no open
	// account — and there are then no sessions to end.
	it('revokes nothing when no open account carried that id', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funShopOwnerDelete.mockImplementationOnce(() => throwNotFoundError('shopOwner not found'))

		await rejection(shopOwnerDel.resolve(null, { _id }, ctx))

		expect(endEveryShopOwnerSession).not.toHaveBeenCalled()
	})

	// A revoke that fails fails the mutation: answering `true` would tell the admin a closed shop owner
	// is off the platform while their sessions are still live.
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEveryShopOwnerSession.mockRejectedValueOnce(new Error('redis down'))

		expect(await rejection(shopOwnerDel.resolve(null, { _id }, ctx))).toMatchObject({
			message: 'Internal Server Error',
			http: { status: 500 }
		})
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
					firstName: '  Mark  ',
					address: { street: '1 Main Street', postalCode: '02109', city: 'Boston', province: 'ma' },
					contacts: { mobile: '3331234567', landline: '   ', email: 'mark@marketplace.test' }
				} as never
			})
		).resolves.toBe(true)

		const [, written] = funShopOwnerUpdate.mock.calls[0]
		expect(written.firstName).toBe('Mark')
		expect(written.address.province).toBe('MA')
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
		endEveryShopOwnerSession.mockReset().mockResolvedValue(undefined)
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
		expect(endEveryShopOwnerSession).not.toHaveBeenCalled()
	})

	// The collision is a 409 the admin can act on, not a 500 — and it must not page anyone.
	it('passes a duplicate-address conflict through with its own status', async () => {
		const { throwAlreadyTakenError } = await import('@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError')
		funShopOwnerUpdateEmail.mockImplementationOnce(() => throwAlreadyTakenError('email: already registered'))

		expect(await rejection(shopOwnerUpdateEmail.resolve(null, { _id, email: 'updated@marketplace.test' }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'email: already registered'
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

	/*
	 * ⚠️ **`login.email` is half of a credential, so writing it ends that account's sessions.**
	 * The old address stops authenticating the moment this write lands; a session minted against it must
	 * stop working for the same reason a session minted against the old password does. After the write,
	 * for the reason `adminUpdatePwd` gives — a collision that never wrote must not log anybody out.
	 */
	it('ends every session the shop owner holds, after the address is written', async () => {
		await expect(shopOwnerUpdateEmail.resolve(null, { _id, email: 'updated@marketplace.test' })).resolves.toBe(true)

		expect(endEveryShopOwnerSession).toHaveBeenCalledExactlyOnceWith(_id)
		expect(endEveryShopOwnerSession.mock.invocationCallOrder[0]).toBeGreaterThan(
			funShopOwnerUpdateEmail.mock.invocationCallOrder[0]
		)
	})

	// The account is the shop owner named by the argument, never the admin sending the mutation: an
	// admin who has just edited somebody else's address has changed nothing about their own credentials,
	// and logging them out mid-page would make the console unusable. The caller rule is about *whose*
	// credentials changed, and here the answer is not the caller's.
	it('revokes nothing when the address was rejected before the write', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funShopOwnerUpdateEmail.mockImplementationOnce(() => throwNotFoundError('shopOwner not found'))

		await rejection(shopOwnerUpdateEmail.resolve(null, { _id, email: 'updated@marketplace.test' }))

		expect(endEveryShopOwnerSession).not.toHaveBeenCalled()
	})

	// A revoke that fails fails the mutation: answering `true` would tell the admin the shop owner is
	// locked out of the old address when they are not.
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEveryShopOwnerSession.mockRejectedValueOnce(new Error('redis down'))

		expect(await rejection(shopOwnerUpdateEmail.resolve(null, { _id, email: 'updated@marketplace.test' }))).toMatchObject({
			message: 'Internal Server Error',
			http: { status: 500 }
		})
	})
})

describe('shopOwnerUpdateStatus', () => {
	beforeEach(() => {
		funShopOwnerUpdateStatus.mockReset().mockResolvedValue(undefined)
		endEveryShopOwnerSession.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// Both flags travel exactly as sent — `false` is a value here, not an omission, which is why the
	// arguments are non-null in the schema. The reason rides along only when it is meaningful.
	it.each([
		[true, true],
		[true, false],
		[false, true],
		[false, false]
	])('forwards disabled=%s waitApprov=%s unchanged', async (disabled, waitApprov) => {
		await expect(
			shopOwnerUpdateStatus.resolve(null, { _id, disabled, waitApprov, disabledReason: 'Fraud report' }, ctx)
		).resolves.toBe(true)

		expect(funShopOwnerUpdateStatus).toHaveBeenCalledExactlyOnceWith({
			_id,
			disabled,
			waitApprov,
			adminId,
			disabledReason: disabled ? 'Fraud report' : undefined
		})
	})

	// ⚠️ **The actor comes off the session, never off the wire** (ADR-044): a `disabledBy` argument would
	// let one admin sign another's name to a suspension. `adminId` above is the session's id and `_id`
	// is the account being suspended, so this assertion fails if the two are ever crossed.
	it('names the admin from the session rather than from the arguments', async () => {
		await expect(
			shopOwnerUpdateStatus.resolve(null, { _id, disabled: true, waitApprov: false, disabledReason: 'Fraud report' }, ctx)
		).resolves.toBe(true)

		expect(funShopOwnerUpdateStatus.mock.calls[0][0]).toMatchObject({ _id, adminId })
	})

	/*
	 * ⚠️ **A suspension with no reason never reaches the database.** The collection's `dependencies` rule
	 * would refuse it too, but as an opaque driver error; `validateDisabledReason` raises the 400 that
	 * names the field, and the write is not attempted.
	 */
	it('refuses a suspension carrying no reason, without writing', async () => {
		expect(await rejection(shopOwnerUpdateStatus.resolve(null, { _id, disabled: true, waitApprov: false }, ctx))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'disabledReason: field required'
		})

		expect(funShopOwnerUpdateStatus).not.toHaveBeenCalled()
		expect(endEveryShopOwnerSession).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funShopOwnerUpdateStatus.mockRejectedValueOnce(new Error('mongo down'))

		await expect(
			shopOwnerUpdateStatus.resolve(null, { _id, disabled: true, waitApprov: false, disabledReason: 'Fraud report' }, ctx)
		).rejects.toThrow('Internal Server Error')
	})

	/*
	 * ⚠️ **One row per target state, and the fourth is the one worth reading.** Either flag
	 * standing means "this account must not be signed in", and until this story the flags said so without
	 * doing anything for up to a refresh window — `checkShopOwnerApproval` and `checkUserAuthorizationDisDel`
	 * only bite at the next rotation. Approving *and* enabling revokes nothing on purpose: nobody's
	 * credentials changed, and logging an owner out as the consequence of being approved is not a control,
	 * it is a bug the four rows below would otherwise hide behind an `||`.
	 */
	it.each([
		[true, true, true],
		[true, false, true],
		[false, true, true],
		[false, false, false]
	])('disabled=%s waitApprov=%s revokes: %s', async (disabled, waitApprov, revokes) => {
		await expect(
			shopOwnerUpdateStatus.resolve(null, { _id, disabled, waitApprov, disabledReason: 'Fraud report' }, ctx)
		).resolves.toBe(true)

		if (revokes) expect(endEveryShopOwnerSession).toHaveBeenCalledExactlyOnceWith(_id)
		else expect(endEveryShopOwnerSession).not.toHaveBeenCalled()
	})

	// After the write, and gated on it: `funShopOwnerUpdateStatus` throws a 404 when `matchedCount !== 1`,
	// so an id that matches nothing must not reach Redis at all — there is no account to log out.
	it('revokes nothing when no shopOwner matched the id', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funShopOwnerUpdateStatus.mockImplementationOnce(() => throwNotFoundError('shopOwner not found'))

		await rejection(
			shopOwnerUpdateStatus.resolve(null, { _id, disabled: true, waitApprov: false, disabledReason: 'Fraud report' }, ctx)
		)

		expect(endEveryShopOwnerSession).not.toHaveBeenCalled()
	})

	it('revokes only after the status is written', async () => {
		await expect(
			shopOwnerUpdateStatus.resolve(null, { _id, disabled: true, waitApprov: false, disabledReason: 'Fraud report' }, ctx)
		).resolves.toBe(true)

		expect(endEveryShopOwnerSession.mock.invocationCallOrder[0]).toBeGreaterThan(
			funShopOwnerUpdateStatus.mock.invocationCallOrder[0]
		)
	})

	// A revoke that fails fails the mutation: answering `true` would tell the admin a disabled shop
	// owner is off the platform while their sessions are still live, which is the lie this revoke exists to stop.
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEveryShopOwnerSession.mockRejectedValueOnce(new Error('redis down'))

		expect(
			await rejection(
				shopOwnerUpdateStatus.resolve(null, { _id, disabled: true, waitApprov: true, disabledReason: 'Fraud report' }, ctx)
			)
		).toMatchObject({
			message: 'Internal Server Error',
			http: { status: 500 }
		})
	})
})

describe('userDel', () => {
	beforeEach(() => {
		funUserDelete.mockReset().mockResolvedValue(undefined)
		endEveryUserSession.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// ⚠️ **The admin's id comes off `ctx.state.user`, never off the wire** (ADR-044). `deletedBy` beside
	// a `deleted` stamp is what tells an admin closure apart from a self-service one, so an argument a
	// client could set would let any admin sign somebody else's name to their decision. `adminId` is the
	// admin and `_id` is the customer: this fails if a refactor ever crosses the two.
	it('soft-deletes the customer in the admin name and answers true', async () => {
		await expect(userDel.resolve(null, { _id }, ctx)).resolves.toBe(true)
		expect(funUserDelete).toHaveBeenCalledExactlyOnceWith(_id, adminId)
	})

	it('propagates the failure', async () => {
		funUserDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(userDel.resolve(null, { _id }, ctx)).rejects.toThrow('Internal Server Error')
	})

	/*
	 * ⚠️ **Closing ends every session the customer holds, unconditionally.** Until this the stamp was a
	 * label: `checkUserAuthorizationDisDel` refuses a closed account at the login gate and
	 * `findAccountForSession` re-runs that on every refresh, but neither bites until the next rotation —
	 * so a closed customer kept shopping for a whole access-token lifetime. Unlike the status mutation
	 * there is no "off" to compare against; a closure has one direction.
	 */
	it('ends every session the customer holds', async () => {
		await expect(userDel.resolve(null, { _id }, ctx)).resolves.toBe(true)

		expect(endEveryUserSession).toHaveBeenCalledExactlyOnceWith(_id)
		expect(endEveryUserSession.mock.invocationCallOrder[0]).toBeGreaterThan(funUserDelete.mock.invocationCallOrder[0])
	})

	// Gated on the write: `funUserDelete` answers 404 when nothing matched — an id naming no open account
	// — and there are then no sessions to end.
	it('revokes nothing when no open account carried that id', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funUserDelete.mockImplementationOnce(() => throwNotFoundError('user not found'))

		await rejection(userDel.resolve(null, { _id }, ctx))

		expect(endEveryUserSession).not.toHaveBeenCalled()
	})

	// A revoke that fails fails the mutation: answering `true` would tell the admin a closed customer is
	// off the platform while their sessions are still live.
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEveryUserSession.mockRejectedValueOnce(new Error('redis down'))

		expect(await rejection(userDel.resolve(null, { _id }, ctx))).toMatchObject({
			message: 'Internal Server Error',
			http: { status: 500 }
		})
	})
})

describe('userUpdateStatus', () => {
	beforeEach(() => {
		funUserUpdateStatus.mockReset().mockResolvedValue(undefined)
		endEveryUserSession.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// The flag travels exactly as sent — `false` is a value here, not an omission, which is why the
	// argument is non-null in the schema. Two rows and no third: there is no `waitApprov` on a customer.
	it.each([[true], [false]])('forwards disabled=%s unchanged', async (disabled) => {
		await expect(userUpdateStatus.resolve(null, { _id, disabled, disabledReason: 'Chargeback ring' }, ctx)).resolves.toBe(true)

		expect(funUserUpdateStatus).toHaveBeenCalledExactlyOnceWith({
			_id,
			disabled,
			adminId,
			disabledReason: disabled ? 'Chargeback ring' : undefined
		})
	})

	// ⚠️ **The actor comes off the session, never off the wire** (ADR-044). `adminId` is the admin and
	// `_id` is the customer, so this fails if a refactor ever crosses the two.
	it('names the admin from the session rather than from the arguments', async () => {
		await expect(userUpdateStatus.resolve(null, { _id, disabled: true, disabledReason: 'Chargeback ring' }, ctx)).resolves.toBe(
			true
		)

		expect(funUserUpdateStatus.mock.calls[0][0]).toMatchObject({ _id, adminId })
	})

	// A suspension with no reason never reaches the collection: `validateDisabledReason` raises the 400
	// that names the field, where the `dependencies` rule would only answer an opaque driver error.
	it('refuses a suspension carrying no reason, without writing', async () => {
		expect(await rejection(userUpdateStatus.resolve(null, { _id, disabled: true }, ctx))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'disabledReason: field required'
		})

		expect(funUserUpdateStatus).not.toHaveBeenCalled()
		expect(endEveryUserSession).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funUserUpdateStatus.mockRejectedValueOnce(new Error('mongo down'))

		await expect(
			userUpdateStatus.resolve(null, { _id, disabled: true, disabledReason: 'Chargeback ring' }, ctx)
		).rejects.toThrow('Internal Server Error')
	})

	/*
	 * ⚠️ **Disabling revokes; re-enabling revokes nothing** (the rule, and the reading,
	 * `shopOwnerUpdateStatus` already gives). Until this mutation existed the flag was a label — the three
	 * gates that read `user.disabled` only bite at the next rotation, so a suspended customer kept a live
	 * session for a whole refresh window. The second row is the one worth reading: signing a customer out
	 * as the consequence of being *re-enabled* is not a control, and an unconditional revoke would hide
	 * behind the first row forever.
	 */
	it.each([
		[true, true],
		[false, false]
	])('disabled=%s revokes: %s', async (disabled, revokes) => {
		await expect(userUpdateStatus.resolve(null, { _id, disabled, disabledReason: 'Chargeback ring' }, ctx)).resolves.toBe(true)

		if (revokes) expect(endEveryUserSession).toHaveBeenCalledExactlyOnceWith(_id)
		else expect(endEveryUserSession).not.toHaveBeenCalled()
	})

	// After the write, and gated on it: `funUserUpdateStatus` raises a 404 when `matchedCount !== 1`, so an
	// id matching no customer must not reach Redis — there is no account to sign out.
	it('revokes nothing when no user matched the id', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funUserUpdateStatus.mockImplementationOnce(() => throwNotFoundError('user not found'))

		await rejection(userUpdateStatus.resolve(null, { _id, disabled: true, disabledReason: 'Chargeback ring' }, ctx))

		expect(endEveryUserSession).not.toHaveBeenCalled()
	})

	it('revokes only after the status is written', async () => {
		await expect(userUpdateStatus.resolve(null, { _id, disabled: true, disabledReason: 'Chargeback ring' }, ctx)).resolves.toBe(
			true
		)

		expect(endEveryUserSession.mock.invocationCallOrder[0]).toBeGreaterThan(funUserUpdateStatus.mock.invocationCallOrder[0])
	})

	// A revoke that fails fails the mutation: answering `true` would tell the admin a suspended customer
	// is off the platform while their sessions are still live, which is the lie this revoke exists to stop.
	it('fails loudly when the sessions cannot be ended, rather than answering true', async () => {
		endEveryUserSession.mockRejectedValueOnce(new Error('redis down'))

		expect(
			await rejection(userUpdateStatus.resolve(null, { _id, disabled: true, disabledReason: 'Chargeback ring' }, ctx))
		).toMatchObject({
			message: 'Internal Server Error',
			http: { status: 500 }
		})
	})

	// ⚠️ The cross-account revoke ends the customer's sessions and nobody else's. `endEverySession` is the
	// caller's own teardown and firing it here would sign the admin out of the console for
	// having suspended somebody — asserted as an absence because that is how it would arrive: a copied line.
	it('leaves the admin signed in', async () => {
		endEverySession.mockReset()

		await expect(userUpdateStatus.resolve(null, { _id, disabled: true, disabledReason: 'Chargeback ring' }, ctx)).resolves.toBe(
			true
		)

		expect(endEverySession).not.toHaveBeenCalled()
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

	// The empty string is a value here, not an omission: it is how the admin clears the note, and
	// the lib turns it into an `$unset`. A box holding only spaces means the same thing and has to
	// arrive the same way — the argument is `String!` precisely so this state has one spelling.
	it.each([[''], ['   '], ['\n\t']])('passes %p through as the clear instruction', async (note) => {
		await expect(shopOwnerUpdateNote.resolve(null, { _id, notes: note })).resolves.toBe(true)
		expect(funShopOwnerUpdateNote).toHaveBeenCalledExactlyOnceWith(_id, '')
	})

	// The collection caps `notes` at 2000. Over that the write would be rejected by MongoDB as a 500
	// with nothing the admin could act on, so the 400 has to be raised here, before the database.
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

	// Two peculiarities: the owner is an argument, because the session is the admin's, and the seat's
	// `position.type` is stamped by the validator rather than sent.
	it('creates the company under the shopOwner it was given, normalised', async () => {
		await expect(companyAdd.resolve(null, { idShopOwner: _id, company })).resolves.toBe(true)

		const [owner, data] = funCompanyAdd.mock.calls[0]
		expect(owner).toBe(_id)
		expect(data.legalName).toBe('Marks Boutique Ltd')
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

	// The 409 the lib raises on a duplicate VAT number is the one an admin can act on, and it must not
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

	// The seat is validated with the company's own prefix, so the admin is told which of the two
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

describe('companyUpdatePublished', () => {
	beforeEach(() => {
		funCompanyUpdatePublished.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// No `validate*` call, unlike `companyAdd` and `companyUpdate`: `Boolean!` is the whole contract, so
	// GraphQL has already refused everything a validator would have. Both values are passed through
	// untouched, and no input object appears — publishing is not a save of the card with one box ticked.
	it.each([
		['unpublishes', false],
		['publishes', true]
	])('%s a company, passing the flag straight through', async (_label, published) => {
		await expect(companyUpdatePublished.resolve(null, { _id, published })).resolves.toBe(true)

		expect(funCompanyUpdatePublished).toHaveBeenCalledExactlyOnceWith(_id, published)
	})

	// ⚠️ The collection's `$expr` refuses `published: true` on a shop with no `slug` and no `publicName`,
	// and that refusal is an admin error rather than a platform failure: it has to keep its status and
	// stay out of Sentry, exactly like the 409 on a duplicate VAT number.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funCompanyUpdatePublished.mockImplementationOnce(() => throwNotFoundError('company not found'))

		expect(await rejection(companyUpdatePublished.resolve(null, { _id, published: true }))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'company not found'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funCompanyUpdatePublished.mockRejectedValueOnce(new Error('mongo down'))

		await expect(companyUpdatePublished.resolve(null, { _id, published: true })).rejects.toThrow('Internal Server Error')
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

	// The refusal an admin meets when the company still has shops: a 409 with a message that says what
	// to do about it, and nothing reported to Sentry.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwConflictError } = await import('@axiumine/koa-utils/graphQL/throw/throwConflictError')
		funCompanyDelete.mockImplementationOnce(() => throwConflictError('company still linked to one or more shops'))

		expect(await rejection(companyDel.resolve(null, { _id }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'company still linked to one or more shops'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funCompanyDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(companyDel.resolve(null, { _id })).rejects.toThrow('Internal Server Error')
	})
})

describe('keygripRotate', () => {
	beforeEach(() => {
		funKeygripRotate.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	/*
	 * ⚠️ The admin's id comes off the Redis session and travels only into the audit event; there is no
	 * argument of any kind, so nothing about the key set is reachable from the request body. The answer is
	 * `true` and never the keys — see `funKeygripRotate` for why that is the whole point.
	 */
	it('rotates on behalf of the session account and answers true', async () => {
		await expect(keygripRotate.resolve(null, {}, ctx)).resolves.toBe(true)

		expect(funKeygripRotate).toHaveBeenCalledExactlyOnceWith(adminId)
	})

	// "Somebody rotated a second ago" and "every key is still verifying cookies" are both 409s the admin
	// can act on. Flattened into a 500 they would read as a broken platform, which is the opposite of true.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwConflictError } = await import('@axiumine/koa-utils/graphQL/throw/throwConflictError')
		funKeygripRotate.mockImplementationOnce(() => throwConflictError('another rotation landed first'))

		expect(await rejection(keygripRotate.resolve(null, {}, ctx))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'another rotation landed first'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('redis down')
		funKeygripRotate.mockRejectedValueOnce(error)

		await expect(keygripRotate.resolve(null, {}, ctx)).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('keygripRetire', () => {
	beforeEach(() => {
		funKeygripRetire.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	/*
	 * ⚠️ The id from the request, the admin from the session, and in that order — an admin argument
	 * would be a way to spend somebody else's rate-limit budget and sign somebody else's name to the audit
	 * event. The answer is `true`; the key set afterwards is `keygripStatus`.
	 */
	it('retires the named key on behalf of the session account and answers true', async () => {
		await expect(keygripRetire.resolve(null, { id: 'k2' }, ctx)).resolves.toBe(true)

		expect(funKeygripRetire).toHaveBeenCalledExactlyOnceWith(adminId, 'k2')
	})

	/*
	 * ⚠️ A 404 here means "nothing was retired", and flattening it into a 500 would leave an admin
	 * responding to a compromise unable to tell a broken platform from a key that is still live.
	 */
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funKeygripRetire.mockImplementationOnce(() => throwNotFoundError('no key in the current set is called k9'))

		expect(await rejection(keygripRetire.resolve(null, { id: 'k9' }, ctx))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'no key in the current set is called k9'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('redis down')
		funKeygripRetire.mockRejectedValueOnce(error)

		await expect(keygripRetire.resolve(null, { id: 'k2' }, ctx)).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledWith(error)
	})
})
