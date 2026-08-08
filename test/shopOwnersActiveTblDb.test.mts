import { trusted } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const find = vi.fn()
const countDocuments = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { find, countDocuments }
}))

const { default: shopOwnersActiveTblDb } = await import('../src/lib/shopOwner/shopOwnersActiveTblDb.mts')

// Spelled out rather than imported from the module under test. Asserting against
// SHOP_OWNERS_TBL_SELECTION is a tautology — it compares the constant with itself, so emptying it
// changes both sides at once and the test still passes while the query stops projecting and starts
// pulling whole documents, `login.password` included, into memory for every row of every page.
const SELECTION = '_id registeredAt personalData.firstName personalData.lastName personalData.address'

type Args = Parameters<typeof shopOwnersActiveTblDb>[0]

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
	return { offset: 0, limit: 25, sortBy: 'REGISTERED_AT', sortDir: 'DESC', ...overrides }
}

function filterOf() {
	return find.mock.calls[0][0]
}

describe('shopOwnersActiveTblDb', () => {
	beforeEach(() => {
		find.mockReset()
		countDocuments.mockReset().mockResolvedValue(0)
	})

	it('pages the active shopOwners and reports the size of the filtered set', async () => {
		const docs = [{ firstName: 'Mark' }]
		const builder = mockFind(docs)
		countDocuments.mockResolvedValueOnce(137)

		await expect(shopOwnersActiveTblDb(args({ offset: 50, limit: 10 }))).resolves.toEqual({
			items: docs,
			total: 137
		})

		expect(builder.select).toHaveBeenCalledExactlyOnceWith(SELECTION)
		expect(builder.skip).toHaveBeenCalledExactlyOnceWith(50)
		expect(builder.limit).toHaveBeenCalledExactlyOnceWith(10)
	})

	// trusted(), not a bare object: sanitizeFilter is on globally, and it rewrites an un-trusted
	// value holding `$` keys into `{ $eq: <that object> }` — which would ask for documents whose
	// `deleted` field literally equals `{$exists:false}`, match nothing, and empty the table.
	it('excludes the disabled and the soft-deleted, and counts exactly what it lists', async () => {
		mockFind([])

		await shopOwnersActiveTblDb(args())

		expect(filterOf().disabled).toEqual(trusted({ $exists: false }))
		expect(filterOf().deleted).toEqual(trusted({ $exists: false }))
		expect(filterOf().$or).toBeUndefined()
		// The same object, not an equal one: two filters that could drift would make `total`
		// describe a different set than `items`, and the paging would be wrong in a way no
		// single-page assertion can see.
		expect(countDocuments).toHaveBeenCalledExactlyOnceWith(filterOf())
	})

	describe('search', () => {
		it('matches a case-insensitive prefix across the three text columns', async () => {
			mockFind([])

			await shopOwnersActiveTblDb(args({ search: 'ros' }))

			expect(filterOf().$or).toEqual([
				{ 'personalData.firstName': /^ros/i },
				{ 'personalData.lastName': /^ros/i },
				{ 'personalData.address.city': /^ros/i }
			])

			const [{ 'personalData.firstName': regex }] = filterOf().$or

			// Asserted separately from the deep-equal above, which compares RegExp objects by source
			// and flags but reads as if it were about the paths.
			expect(regex.source).toBe('^ros')
			expect(regex.flags).toBe('i')
		})

		// The term is interpolated into a RegExp the database evaluates, so every character RegExp
		// gives a meaning to has to lose it. Unescaped, `.*` is a full scan and `(a+)+$` is a
		// backtracking bomb the caller picked.
		it('escapes every regex metacharacter in the term', async () => {
			mockFind([])

			await shopOwnersActiveTblDb(args({ search: 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o' }))

			const [{ 'personalData.firstName': regex }] = filterOf().$or

			expect(regex.source).toBe('^a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o')
			expect(regex.test('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(true)
			// The literal string is the only thing it matches: without escaping, this would too.
			expect(regex.test('aXbYcZ')).toBe(false)
		})

		it('anchors the match, so a substring in the middle of a name is not a hit', async () => {
			mockFind([])

			await shopOwnersActiveTblDb(args({ search: 'ossi' }))

			const [{ 'personalData.firstName': regex }] = filterOf().$or

			expect(regex.test('Rivers')).toBe(false)
			expect(regex.test('ossido')).toBe(true)
		})

		it('trims the term before using it', async () => {
			mockFind([])

			await shopOwnersActiveTblDb(args({ search: '  ros  ' }))

			expect(filterOf().$or[0]).toEqual({ 'personalData.firstName': /^ros/i })
		})

		// A text box that has been cleared sends '' or '   ', and neither means "search for
		// whitespace". Leaving the $or out entirely keeps the no-search case a pure indexed query.
		it.each([
			['undefined', undefined],
			['null', null],
			['empty', ''],
			['whitespace only', '   ']
		])('treats %s as no search at all', async (_label, search) => {
			mockFind([])

			await shopOwnersActiveTblDb(args({ search }))

			expect(filterOf().$or).toBeUndefined()
		})

		it('accepts a term of exactly the maximum length', async () => {
			mockFind([])

			await expect(shopOwnersActiveTblDb(args({ search: 'a'.repeat(100) }))).resolves.toBeDefined()
		})

		it('rejects a term one character past the maximum', async () => {
			await expect(shopOwnersActiveTblDb(args({ search: 'a'.repeat(101) }))).rejects.toMatchObject({
				message: 'Bad Request',
				extensions: { http: { status: 400 }, description: 'search must be at most 100 characters' }
			})

			expect(find).not.toHaveBeenCalled()
		})
	})

	describe('sorting', () => {
		// One case per enum value per direction. The mapping from enum name to Mongo path is the
		// whole point of the enum being value-less, and each of these paths is the one an index in
		// marketplace-db-setup was built for — a typo here silently downgrades the query to a blocking
		// in-memory sort rather than failing.
		it.each([
			['REGISTERED_AT', 'DESC', { registeredAt: -1, _id: -1 }],
			['REGISTERED_AT', 'ASC', { registeredAt: 1, _id: 1 }],
			['FIRST_NAME', 'DESC', { 'personalData.firstName': -1, _id: -1 }],
			['FIRST_NAME', 'ASC', { 'personalData.firstName': 1, _id: 1 }],
			['LAST_NAME', 'DESC', { 'personalData.lastName': -1, 'personalData.firstName': -1, _id: -1 }],
			['LAST_NAME', 'ASC', { 'personalData.lastName': 1, 'personalData.firstName': 1, _id: 1 }],
			['CITY', 'DESC', { 'personalData.address.city': -1, _id: -1 }],
			['CITY', 'ASC', { 'personalData.address.city': 1, _id: 1 }]
		])('sorts by %s %s', async (sortBy, sortDir, expected) => {
			const builder = mockFind([])

			await shopOwnersActiveTblDb(args({ sortBy: sortBy as Args['sortBy'], sortDir: sortDir as Args['sortDir'] }))

			expect(builder.sort).toHaveBeenCalledExactlyOnceWith(expected)
		})

		// Key ORDER, not just presence: a sort document is ordered, so `{_id, registeredAt}` is a
		// different query from `{registeredAt, _id}` — and only the second one an index can serve.
		it('breaks ties on _id, last', async () => {
			const builder = mockFind([])

			await shopOwnersActiveTblDb(args({ sortBy: 'LAST_NAME' }))

			expect(Object.keys(builder.sort.mock.calls[0][0])).toEqual(['personalData.lastName', 'personalData.firstName', '_id'])
		})
	})

	describe('paging bounds', () => {
		it.each([
			['a negative offset', { offset: -1 }, 'offset must be 0 or greater'],
			['a zero limit', { limit: 0 }, 'limit must be 1 or greater'],
			['a limit past the ceiling', { limit: 101 }, 'limit must be at most 100']
		])('rejects %s', async (_label, overrides, description) => {
			await expect(shopOwnersActiveTblDb(args(overrides))).rejects.toMatchObject({
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

			await expect(shopOwnersActiveTblDb(args(overrides))).resolves.toBeDefined()
		})

		// No upper bound on offset, deliberately: a deep skip is slow but correct, and capping it
		// would make the last pages of a large result set unreachable.
		it('accepts an offset far past the end of the collection', async () => {
			mockFind([])

			await expect(shopOwnersActiveTblDb(args({ offset: 1_000_000 }))).resolves.toBeDefined()
		})
	})
})
