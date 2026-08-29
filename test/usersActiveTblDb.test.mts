import { trusted } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const find = vi.fn()
const countDocuments = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({
	User: { find, countDocuments }
}))

const { default: usersActiveTblDb } = await import('../src/lib/user/usersActiveTblDb.mts')

// Spelled out rather than imported from the module under test. Asserting against USERS_TBL_SELECTION
// is a tautology — it compares the constant with itself, so emptying it changes both sides at once and
// the test still passes while the query stops projecting and starts pulling whole documents through
// the decryption layer: every address, every name, `login.password` included, for every row of every
// page.
const SELECTION = '_id registeredAt login.email disabled disabledBy disabledReason deleted emailVerify.valid'

type Args = Parameters<typeof usersActiveTblDb>[0]

/** The query builder, mocked one link per chained call: find → select → sort → skip → limit → lean. */
function mockFind(items: unknown[]) {
	const lean = vi.fn().mockResolvedValue(items)
	const limit = vi.fn().mockReturnValue({ lean })
	const skip = vi.fn().mockReturnValue({ limit })
	const sort = vi.fn().mockReturnValue({ skip })
	const select = vi.fn().mockReturnValue({ sort })

	find.mockReturnValueOnce({ select })

	return { select, sort, skip, limit, lean }
}

/** Every test overrides only what it is about; these are the resolver's own defaults. */
function args(overrides: Partial<Args> = {}): Args {
	return { offset: 0, limit: 25, disabled: false, deleted: false, sortBy: 'REGISTERED_AT', sortDir: 'DESC', ...overrides }
}

function filterOf() {
	return find.mock.calls[0][0]
}

describe('usersActiveTblDb', () => {
	beforeEach(() => {
		find.mockReset()
		countDocuments.mockReset().mockResolvedValue(0)
	})

	it('pages the customers and reports the size of the filtered set', async () => {
		const docs = [{ _id: 'a' }]
		const builder = mockFind(docs)
		countDocuments.mockResolvedValueOnce(137)

		await expect(usersActiveTblDb(args({ offset: 50, limit: 10 }))).resolves.toEqual({
			items: docs,
			total: 137
		})

		expect(builder.select).toHaveBeenCalledExactlyOnceWith(SELECTION)
		expect(builder.skip).toHaveBeenCalledExactlyOnceWith(50)
		expect(builder.limit).toHaveBeenCalledExactlyOnceWith(10)
	})

	// ⚠️ The projection is the boundary this whole epic is built around (ADR-029, E19-S05). Every
	// personal field on `user` is encrypted, `login.email` is the one the admin is allowed to read,
	// and a name or an address tidied into the projection would be decrypted on the way out and land on
	// a screen with no task for it. Asserted from both sides: the address must be there, the two PII
	// roots must not.
	it('projects the login address and nothing personal beyond it', async () => {
		const builder = mockFind([])

		await usersActiveTblDb(args())

		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('login.email'))
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.not.stringContaining('personalData'))
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.not.stringContaining('addresses'))
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.not.stringContaining('password'))
	})

	// ⚠️ Asserted as an absence, because the absence is the story (E19-S05). `$or` is the shape a prefix
	// search takes on the shop-owner table; against `user` the same clause compares a name to base64 and
	// returns an empty customer base without erroring, on every term.
	it('never builds a search clause, whatever it is handed', async () => {
		mockFind([])

		await usersActiveTblDb({ ...args(), search: 'ros' } as Args & { search: string })

		expect(filterOf().$or).toBeUndefined()
		expect(Object.keys(filterOf())).toEqual(['deleted', 'disabled'])
	})

	describe('the three filters', () => {
		// trusted(), not a bare object: sanitizeFilter is on globally and rewrites an un-trusted value
		// holding `$` keys into `{ $eq: <that object> }` — which would ask for documents whose `deleted`
		// field literally equals `{$exists: false}`, match nothing, and empty the table.
		it('defaults to the live, enabled accounts and counts exactly what it lists', async () => {
			mockFind([])

			await usersActiveTblDb(args())

			expect(filterOf().deleted).toEqual(trusted({ $exists: false }))
			expect(filterOf().disabled).toEqual(trusted({ $exists: false }))
			expect(filterOf()['emailVerify.valid']).toBeUndefined()
			// The same object, not an equal one: two filters that could drift would make `total`
			// describe a different set than `items`, and the paging would be wrong in a way no
			// single-page assertion can see.
			expect(countDocuments).toHaveBeenCalledExactlyOnceWith(filterOf())
		})

		// ⚠️ `disabled: true` is an equality and `deleted: true` is an existence check, and swapping
		// either is silent. `disabled` is stored `true` or removed, so `{$exists: true}` there would
		// also match a hypothetical stored `false`; `deleted` is a timestamp, so `{$eq: true}` there
		// would match nothing at all and the deleted page would render empty for ever.
		it('asks for the disabled by equality and for the soft-deleted by existence', async () => {
			mockFind([])

			await usersActiveTblDb(args({ disabled: true, deleted: true }))

			expect(filterOf().disabled).toBe(true)
			expect(filterOf().deleted).toEqual(trusted({ $exists: true }))
		})

		// The key ORDER is the index order (`{deleted, disabled, registeredAt, _id}`). Nothing in
		// MongoDB requires it — the planner reorders predicates itself — but a filter that reads in the
		// index's order is what makes a wrong one visible when somebody compares the two.
		it('keys the filter in the order the index is keyed', async () => {
			mockFind([])

			await usersActiveTblDb(args({ emailVerified: true }))

			expect(Object.keys(filterOf())).toEqual(['deleted', 'disabled', 'emailVerify.valid'])
		})

		// ⚠️ `$ne: true`, never `$eq: false`. `enableEmailAccess` is what writes `valid`, so an account
		// that has never confirmed has no key there — `{valid: false}` would answer "nobody is
		// unverified" on precisely the accounts that are, which is the one question this filter exists
		// to ask.
		it.each([
			['true', true, true],
			['false', false, trusted({ $ne: true })]
		])('narrows to emailVerified %s', async (_label, emailVerified, expected) => {
			mockFind([])

			await usersActiveTblDb(args({ emailVerified }))

			expect(filterOf()['emailVerify.valid']).toEqual(expected)
		})

		// The tri-state, and the only one. An argument that was not sent and one that was sent as null
		// both mean "show both", and neither may leave a clause behind — a `{valid: null}` in the filter
		// would match only the accounts that have never asked for a link, which is the opposite of
		// "show both".
		it.each([
			['undefined', undefined],
			['null', null]
		])('treats %s as no email-verification filter at all', async (_label, emailVerified) => {
			mockFind([])

			await usersActiveTblDb(args({ emailVerified }))

			expect(Object.keys(filterOf())).toEqual(['deleted', 'disabled'])
		})
	})

	describe('sorting', () => {
		// ⚠️ One column, and the test says so from both sides: the mapping from the enum name to the
		// Mongo path (a typo there silently downgrades the query to a blocking in-memory sort rather
		// than failing) and the fact that the map has no second entry. A `personalData.lastName` added
		// to it would order the customer base by ciphertext — stable, arbitrary, and indistinguishable
		// from a working sort (E19-S05).
		it.each([
			['DESC', { registeredAt: -1, _id: -1 }],
			['ASC', { registeredAt: 1, _id: 1 }]
		])('sorts by REGISTERED_AT %s', async (sortDir, expected) => {
			const builder = mockFind([])

			await usersActiveTblDb(args({ sortDir: sortDir as Args['sortDir'] }))

			expect(builder.sort).toHaveBeenCalledExactlyOnceWith(expected)
		})

		// Key ORDER, not just presence: a sort document is ordered, so `{_id, registeredAt}` is a
		// different query from `{registeredAt, _id}` — and only the second one the index can serve.
		// Both components carry the SAME direction, which is what lets one index serve ASC and DESC.
		it('breaks ties on _id, last, in the same direction', async () => {
			const builder = mockFind([])

			await usersActiveTblDb(args({ sortDir: 'ASC' }))

			expect(Object.keys(builder.sort.mock.calls[0][0])).toEqual(['registeredAt', '_id'])
		})
	})

	describe('paging bounds', () => {
		it.each([
			['a negative offset', { offset: -1 }, 'offset must be 0 or greater'],
			['a zero limit', { limit: 0 }, 'limit must be 1 or greater'],
			['a limit past the ceiling', { limit: 101 }, 'limit must be at most 100']
		])('rejects %s', async (_label, overrides, description) => {
			await expect(usersActiveTblDb(args(overrides))).rejects.toMatchObject({
				message: 'Bad Request',
				extensions: { http: { status: 400 }, description }
			})

			// The point of validating: no query is issued at all.
			expect(find).not.toHaveBeenCalled()
			expect(countDocuments).not.toHaveBeenCalled()
		})

		// The three boundary values that are legal. Without these, moving any comparison one step
		// (`>` to `>=`) would still pass every rejection test above.
		it.each([
			['offset 0', { offset: 0 }],
			['limit 1', { limit: 1 }],
			['limit at the ceiling', { limit: 100 }]
		])('accepts %s', async (_label, overrides) => {
			mockFind([])

			await expect(usersActiveTblDb(args(overrides))).resolves.toBeDefined()
		})

		// No upper bound on offset, deliberately: a deep skip is slow but correct, and capping it would
		// make the last pages of a large result set unreachable.
		it('accepts an offset far past the end of the collection', async () => {
			mockFind([])

			await expect(usersActiveTblDb(args({ offset: 1_000_000 }))).resolves.toBeDefined()
		})
	})
})
