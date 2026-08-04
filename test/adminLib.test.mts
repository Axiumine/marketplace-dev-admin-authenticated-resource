import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findById = vi.fn()
const updateOne = vi.fn()
const compareHashAsync = vi.fn()
const encryptPassword = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Admin', () => ({ Admin: { findById, updateOne } }))
// bcrypt itself is not under test and costs ~1 s per call at SALT_ROUNDS 14, so the two koa-utils
// wrappers around it are stubbed. checkPwdLen and checkUserAuthorizationDisDel are deliberately NOT
// mocked: what they reject is part of this function's contract, and stubbing them would let the
// calls be deleted without a single test noticing.
vi.mock('@axiumine/koa-utils/lib/hash', () => ({ compareHashAsync }))
vi.mock('@axiumine/koa-utils/lib/encryptPassword', () => ({ encryptPassword }))

const { funAdminUpdatePwd } = await import('../src/lib/admin/funAdminUpdatePwd.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
const OLD = 'vecchiaPassword1'
const NEW = 'nuovaPassword1'
const HASH = '$2b$14$' + 'x'.repeat(53)

/** `findById(...).select(...).lean()` — two links to mock. */
function mockAdmin(doc: unknown) {
	const lean = vi.fn().mockResolvedValue(doc)
	const select = vi.fn().mockReturnValue({ lean })

	findById.mockReturnValueOnce({ select })

	return { select, lean }
}

function mockUpdate(modifiedCount: number) {
	updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ modifiedCount }) })
}

/** The stored account, as projected. */
function storedAdmin(extra: Record<string, unknown> = {}) {
	return { _id, login: { password: HASH }, ...extra }
}

describe('funAdminUpdatePwd', () => {
	beforeEach(() => {
		findById.mockReset()
		updateOne.mockReset()
		compareHashAsync.mockReset().mockResolvedValue(true)
		encryptPassword.mockReset().mockResolvedValue(HASH)
	})

	it('re-hashes the new password and writes it to the session account', async () => {
		const admin = mockAdmin(storedAdmin())
		mockUpdate(1)

		await expect(funAdminUpdatePwd(_id, OLD, NEW)).resolves.toBeUndefined()

		expect(findById).toHaveBeenCalledExactlyOnceWith(_id)
		// The projection is asserted verbatim: `login.password` is what gets compared, and pulling
		// anything else about the account into memory alongside it has no reason to happen.
		expect(admin.select).toHaveBeenCalledExactlyOnceWith('_id disabled deleted login.password')
		expect(compareHashAsync).toHaveBeenCalledExactlyOnceWith(OLD, HASH)
		// The stored value is the HASH, never the plaintext. `updateOne` is a query, so the
		// pre('save') hook in marketplace-common that would normally hash `password` never runs — if
		// this call were dropped, the cleartext password would go straight into MongoDB.
		expect(encryptPassword).toHaveBeenCalledExactlyOnceWith(NEW)
		expect(updateOne).toHaveBeenCalledExactlyOnceWith({ _id }, { $set: { 'login.password': HASH } })
	})

	// The old password is the re-authentication step, and the reason the mutation takes it at all:
	// an access token is a bearer credential, so without this a stolen token becomes permanent
	// ownership of the account.
	it('refuses when the old password does not match, and writes nothing', async () => {
		mockAdmin(storedAdmin())
		compareHashAsync.mockResolvedValueOnce(false)

		await expect(funAdminUpdatePwd(_id, OLD, NEW)).rejects.toMatchObject({
			message: 'Unauthorized',
			extensions: { http: { status: 401 } }
		})

		expect(encryptPassword).not.toHaveBeenCalled()
		expect(updateOne).not.toHaveBeenCalled()
	})

	// 401 rather than 404, and the same 401 as a wrong password above: the caller learns their
	// session is no good and nothing else about the account.
	it('refuses when the session points at an account that no longer exists', async () => {
		mockAdmin(null)

		await expect(funAdminUpdatePwd(_id, OLD, NEW)).rejects.toMatchObject({
			message: 'Unauthorized',
			extensions: { http: { status: 401 } }
		})

		expect(compareHashAsync).not.toHaveBeenCalled()
		expect(updateOne).not.toHaveBeenCalled()
	})

	// A disabled or soft-deleted operator keeps a working access token until it expires. The gate
	// runs BEFORE the password is compared, so a suspended account cannot use this endpoint to
	// confirm a guess either.
	it.each([
		['disabled', { disabled: true }],
		['soft-deleted', { deleted: new Date() }]
	])('refuses a %s operator before comparing anything', async (_label, state) => {
		mockAdmin(storedAdmin(state))

		await expect(funAdminUpdatePwd(_id, OLD, NEW)).rejects.toMatchObject({
			message: 'Unauthorized',
			extensions: { http: { status: 401 } }
		})

		expect(compareHashAsync).not.toHaveBeenCalled()
		expect(updateOne).not.toHaveBeenCalled()
	})

	describe('new password validation', () => {
		// koa-utils' bounds, 10 to 72. The upper one is the one worth a test: bcrypt hashes at most
		// 72 bytes and ignores the rest, so an unbounded passphrase would be stored as its prefix
		// while the operator believes the whole thing protects the account.
		it.each([
			['too short', 'a'.repeat(9), 'Password is too short'],
			['too long', 'a'.repeat(73), 'Password is too long']
		])('rejects a new password that is %s', async (_label, passwordNew, description) => {
			await expect(funAdminUpdatePwd(_id, OLD, passwordNew)).rejects.toMatchObject({
				message: 'Bad Request',
				extensions: { http: { status: 400 }, description }
			})

			expect(findById).not.toHaveBeenCalled()
		})

		it('rejects a new password identical to the old one', async () => {
			await expect(funAdminUpdatePwd(_id, OLD, OLD)).rejects.toMatchObject({
				message: 'Bad Request',
				extensions: { http: { status: 400 }, description: 'passwordNew must differ from passwordOld' }
			})

			// Checked before the read: no round-trip, and no bcrypt hash spent at cost factor 14 to
			// write back a value that is already stored.
			expect(findById).not.toHaveBeenCalled()
			expect(encryptPassword).not.toHaveBeenCalled()
		})
	})

	// The document was read a moment earlier and the hash is salted, so it cannot equal what is
	// stored — anything but one modified document means the write did not land, and the caller must
	// not be told their password changed when it did not.
	it('raises a 500 when the update did not modify exactly one document', async () => {
		mockAdmin(storedAdmin())
		mockUpdate(0)

		await expect(funAdminUpdatePwd(_id, OLD, NEW)).rejects.toThrow('Internal Server Error')
	})
})
