import { trusted } from 'mongoose'
import type { Mock } from 'vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { filterOf, mockFindChain } from './tblQueryMocks.mts'

const find = vi.fn()
const countDocuments = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { find, countDocuments }
}))

const { default: shopOwnersActiveTblDb } = await import('../src/lib/shopOwner/shopOwnersActiveTblDb.mts')

// Spelled out rather than imported from the module under test. Asserting against
// SHOP_OWNERS_TBL_SELECTION is a tautology — it compares the constant with itself, so emptying it
// changes both sides at once and the test still passes while the query stops projecting and starts
// pulling whole documents, `login.password` included, into memory for every shopOwner of every page.
const SELECTION =
	'_id registeredAt login.email waitApprov disabled disabledBy disabledReason deleted ' +
	'personalData.firstName personalData.lastName personalData.address'

type Args = Parameters<typeof shopOwnersActiveTblDb>[0]

/** Every test overrides only what it is about; these are the resolver's own defaults. */
function args(overrides: Partial<Args> = {}): Args {
	return { offset: 0, limit: 25, disabled: false, deleted: false, sortBy: 'REGISTERED_AT', sortDir: 'DESC', ...overrides }
}

/**
 * The `$or` branch of the filter, typed as `buildFilter` actually builds it — one `{ path: RegExp }`
 * entry per searchable column. `filterOf` stays untyped on purpose (it serves every table's filter
 * shape); this narrows the one field these tests read, and the `Array.isArray` check is what earns the
 * cast rather than assuming it.
 */
function orOf(mockFind: Mock): Record<string, RegExp>[] {
	const { $or } = filterOf(mockFind)

	if (!Array.isArray($or)) {
		throw new Error('expected the filter to carry an $or array')
	}

	return $or as Record<string, RegExp>[]
}

describe('shopOwnersActiveTblDb', () => {
	beforeEach(() => {
		find.mockReset()
		countDocuments.mockReset().mockResolvedValue(0)
	})

	it('pages the active shopOwners and reports the size of the filtered set', async () => {
		const docs = [{ firstName: 'Mark' }]
		const builder = mockFindChain(find, docs)
		countDocuments.mockResolvedValueOnce(137)

		await expect(shopOwnersActiveTblDb(args({ offset: 50, limit: 10 }))).resolves.toEqual({
			items: docs,
			total: 137
		})

		expect(builder.select).toHaveBeenCalledExactlyOnceWith(SELECTION)
		expect(builder.skip).toHaveBeenCalledExactlyOnceWith(50)
		expect(builder.limit).toHaveBeenCalledExactlyOnceWith(10)
	})

	// ⚠️ The two fields that make this table the approval queue. A self-registered shop owner has no
	// `personalData` at all, so `login.email` is the only thing identifying the row an admin is
	// about to approve, and `waitApprov` is the only thing saying it needs approving. Dropping either
	// leaves a page that renders and is useless — which is why they are named here and not merely
	// inside the constant.
	it('projects the address and the approval flag, or the queue is a page of blank rows', async () => {
		const builder = mockFindChain(find, [])

		await shopOwnersActiveTblDb(args())

		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('login.email'))
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('waitApprov'))
	})

	// ⚠️ The filter binds the two state fields and **nothing else** — asserted from the other side
	// here, because a `waitApprov: { $exists: false }` clause added to "show only real shop owners"
	// would hide every account waiting for an admin from the only table that lists them. Waiting for
	// approval is not a fifth state: an account can be pending under any of the four.
	//
	// The key ORDER is the index order — all four `tbl_active_*` lead with `{deleted, disabled}`.
	// Nothing in MongoDB requires it, the planner reorders predicates itself, but a filter that reads
	// in the index's order is what makes a wrong one visible when somebody compares the two.
	it('lists accounts awaiting approval rather than filtering them out', async () => {
		mockFindChain(find, [])

		await shopOwnersActiveTblDb(args())

		expect(Object.keys(filterOf(find))).toEqual(['deleted', 'disabled'])
	})

	// ⚠️ The status columns. `shopOwnerDel` stamps `deleted` and leaves the `disabled` trio exactly as
	// it found it, so one row can carry both — and a table projecting neither would print "Active"
	// over an account that is suspended, closed, or both. `disabledReason` is legible here and on
	// `shopOwnerById` and nowhere else: it is randomly encrypted (ADR-029) and this service holds the
	// data key.
	it('projects the state fields the status column reads', async () => {
		const builder = mockFindChain(find, [])

		await shopOwnersActiveTblDb(args())

		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('disabledBy'))
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('disabledReason'))
		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('deleted'))
	})

	// The password never leaves the database on this path. The projection is a positive list, so this
	// holds by construction — and it is asserted anyway, because the table is the one query here that
	// runs for every row of every page and a whole-document fetch would be invisible in the output.
	it('never projects the credential', async () => {
		const builder = mockFindChain(find, [])

		await shopOwnersActiveTblDb(args())

		expect(builder.select).toHaveBeenCalledExactlyOnceWith(expect.not.stringContaining('password'))
	})

	describe('the account-state matrix', () => {
		// trusted(), not a bare object: sanitizeFilter is on globally, and it rewrites an un-trusted
		// value holding `$` keys into `{ $eq: <that object> }` — which would ask for documents whose
		// `deleted` field literally equals `{$exists:false}`, match nothing, and empty the table.
		it('defaults to the live, enabled accounts and counts exactly what it lists', async () => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args())

			expect(filterOf(find).deleted).toEqual(trusted({ $exists: false }))
			expect(filterOf(find).disabled).toEqual(trusted({ $exists: false }))
			expect(filterOf(find).$or).toBeUndefined()
			// The same object, not an equal one: two filters that could drift would make `total`
			// describe a different set than `items`, and the paging would be wrong in a way no
			// single-page assertion can see.
			expect(countDocuments).toHaveBeenCalledExactlyOnceWith(filterOf(find))
		})

		// ⚠️ `disabled: true` is an equality and `deleted: true` is an existence check, and swapping
		// either is silent. `disabled` is stored `true` or removed, so `{$exists: true}` there would
		// also match a hypothetical stored `false`; `deleted` is a timestamp, so `{$eq: true}` there
		// would match nothing at all and the closed page would render empty for ever.
		it('asks for the disabled by equality and for the soft-deleted by existence', async () => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ disabled: true, deleted: true }))

			expect(filterOf(find).disabled).toBe(true)
			expect(filterOf(find).deleted).toEqual(trusted({ $exists: true }))
		})

		// ⚠️ Four states, and the fourth is the reason the pair is two arguments rather than one enum
		// of three: `shopOwnerDel` stamps `deleted` and leaves the `disabled` trio alone, so an account
		// suspended and then closed carries both — and under a filter that offered "active or
		// suspended or closed" it would answer to none of them and be unreachable from the admin's
		// only table of shop owners (ADR-049).
		it.each([
			{
				state: 'active',
				disabled: false,
				deleted: false,
				isDisabled: trusted({ $exists: false }),
				isDeleted: trusted({ $exists: false })
			},
			{ state: 'suspended', disabled: true, deleted: false, isDisabled: true, isDeleted: trusted({ $exists: false }) },
			{
				state: 'closed',
				disabled: false,
				deleted: true,
				isDisabled: trusted({ $exists: false }),
				isDeleted: trusted({ $exists: true })
			},
			{ state: 'closed and suspended', disabled: true, deleted: true, isDisabled: true, isDeleted: trusted({ $exists: true }) }
		])('narrows to the $state accounts', async ({ disabled, deleted, isDisabled, isDeleted }) => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ disabled, deleted }))

			expect(filterOf(find).disabled).toEqual(isDisabled)
			expect(filterOf(find).deleted).toEqual(isDeleted)
		})
	})

	describe('search', () => {
		it('matches a case-insensitive prefix across the three text columns', async () => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ search: 'ros' }))

			expect(filterOf(find).$or).toEqual([
				{ 'personalData.firstName': /^ros/i },
				{ 'personalData.lastName': /^ros/i },
				{ 'personalData.address.city': /^ros/i }
			])

			const [{ 'personalData.firstName': regex }] = orOf(find)

			// Asserted separately from the deep-equal above, which compares RegExp objects by source
			// and flags but reads as if it were about the paths.
			expect(regex.source).toBe('^ros')
			expect(regex.flags).toBe('i')
		})

		// The term is interpolated into a RegExp the database evaluates, so every character RegExp
		// gives a meaning to has to lose it. Unescaped, `.*` is a full scan and `(a+)+$` is a
		// backtracking bomb the caller picked.
		it('escapes every regex metacharacter in the term', async () => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ search: 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o' }))

			const [{ 'personalData.firstName': regex }] = orOf(find)

			expect(regex.source).toBe('^a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o')
			expect(regex.test('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(true)
			// The literal string is the only thing it matches: without escaping, this would too.
			expect(regex.test('aXbYcZ')).toBe(false)
		})

		it('anchors the match, so a substring in the middle of a name is not a hit', async () => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ search: 'ossi' }))

			const [{ 'personalData.firstName': regex }] = orOf(find)

			expect(regex.test('Rivers')).toBe(false)
			expect(regex.test('ossido')).toBe(true)
		})

		it('trims the term before using it', async () => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ search: '  ros  ' }))

			expect(orOf(find)[0]).toEqual({ 'personalData.firstName': /^ros/i })
		})

		// A text box that has been cleared sends '' or '   ', and neither means "search for
		// whitespace". Leaving the $or out entirely keeps the no-search case a pure indexed query.
		it.each([
			['undefined', undefined],
			['null', null],
			['empty', ''],
			['whitespace only', '   ']
		])('treats %s as no search at all', async (_label, search) => {
			mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ search }))

			expect(filterOf(find).$or).toBeUndefined()
		})

		it('accepts a term of exactly the maximum length', async () => {
			mockFindChain(find, [])

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
			const builder = mockFindChain(find, [])

			await shopOwnersActiveTblDb(args({ sortBy: sortBy as Args['sortBy'], sortDir: sortDir as Args['sortDir'] }))

			expect(builder.sort).toHaveBeenCalledExactlyOnceWith(expected)
		})

		// Key ORDER, not just presence: a sort document is ordered, so `{_id, registeredAt}` is a
		// different query from `{registeredAt, _id}` — and only the second one an index can serve.
		it('breaks ties on _id, last', async () => {
			const builder = mockFindChain(find, [])

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
			mockFindChain(find, [])

			await expect(shopOwnersActiveTblDb(args(overrides))).resolves.toBeDefined()
		})

		// No upper bound on offset, deliberately: a deep skip is slow but correct, and capping it
		// would make the last pages of a large result set unreachable.
		it('accepts an offset far past the end of the collection', async () => {
			mockFindChain(find, [])

			await expect(shopOwnersActiveTblDb(args({ offset: 1_000_000 }))).resolves.toBeDefined()
		})
	})
})
