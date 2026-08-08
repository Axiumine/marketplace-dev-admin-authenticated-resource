import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { IShopOwnerModel } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IShopOwnerModel'
import { QueryFilter, trusted } from 'mongoose'

/**
 * Server-side paging for the operator's shopOwners table.
 *
 * The query this replaces had no `skip`, no `limit` and no `sort`: it returned every active
 * shopOwner on every page load and let the browser slice the result. That is fine at 20 rows and
 * a growing liability after that — the response size, the Mongo working set and the JSON parse on
 * the client all scale with the collection while the user still looks at 25 rows.
 */

export const SHOP_OWNERS_TBL_DEFAULT_LIMIT = 25

/**
 * Hard server-side ceiling on `limit`. Without it the argument is a client-controlled way back to
 * the unbounded query — `limit: 1000000` would be honoured and the pagination would be decoration.
 */
export const SHOP_OWNERS_TBL_MAX_LIMIT = 100

/** Bounds the regex the search builds. See `prefixRegExp` for why the length matters. */
export const SHOP_OWNERS_TBL_MAX_SEARCH_LENGTH = 100

/** The projection the GraphQL table type consumes. A field dropped here nulls a NonNull. */
export const SHOP_OWNERS_TBL_SELECTION = '_id registeredAt personalData.firstName personalData.lastName personalData.address'

/**
 * GraphQL enum name → the Mongo paths to sort by, in order. `_id` is appended to every one of these
 * by `buildSort`, so the orderings below are the tie-broken prefix, not the whole sort.
 *
 * LAST_NAME carries two paths because sorting people by surname alone leaves same-surname rows in
 * arbitrary order, which reads as a bug in a table. Every entry has a matching compound index in
 * marketplace-db-setup (`tbl_active_*`); adding a key here without adding the index brings back the
 * blocking in-memory sort those indexes exist to prevent.
 */
const SORT_PATHS = {
	REGISTERED_AT: ['registeredAt'],
	FIRST_NAME: ['personalData.firstName'],
	LAST_NAME: ['personalData.lastName', 'personalData.firstName'],
	CITY: ['personalData.address.city']
} as const

const SORT_ORDERS = { ASC: 1, DESC: -1 } as const

export type ShopOwnersTblSortField = keyof typeof SORT_PATHS
export type ShopOwnersTblSortDirection = keyof typeof SORT_ORDERS

/** The fields `search` looks in. Kept to the three columns the table actually renders as text. */
const SEARCHABLE_PATHS = ['personalData.firstName', 'personalData.lastName', 'personalData.address.city']

export interface IShopOwnersActiveTblArgs {
	offset: number
	limit: number
	search?: string | null
	sortBy: ShopOwnersTblSortField
	sortDir: ShopOwnersTblSortDirection
}

export interface IShopOwnersActiveTblPage {
	items: unknown[]
	total: number
}

/**
 * Escapes every character RegExp gives a meaning to, so a search term is matched literally.
 *
 * Not cosmetic: the term goes straight into a `RegExp` the database evaluates. Unescaped, `(a+)+$`
 * is a catastrophically backtracking pattern the caller chose, and `.*` is a full scan dressed up as
 * a search. Escaping first means the only regex MongoDB ever sees from this path is an anchored
 * literal, which is linear in the length of the field.
 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive PREFIX match — `^term`, not `term` anywhere in the field.
 *
 * Anchoring is the difference between "type M, get everyone whose name starts with M" and a
 * substring scan, and it is the semantics a name column wants. It does NOT buy an index scan: the
 * `i` flag disqualifies the index outright (and `$regex` ignores collation, so a case-insensitive
 * collation on the index does not rescue it). The anchor is about matching behaviour and about
 * bounding the work per document; the index question is answered in the migration's comments.
 */
function prefixRegExp(term: string): RegExp {
	return new RegExp(`^${escapeRegExp(term)}`, 'i')
}

/**
 * Normalises `search` to either a usable term or `undefined`.
 *
 * A whitespace-only string is treated as absent rather than as a search for whitespace: the input
 * comes from a text box, and `'   '` there means the user cleared it. Returning `undefined` keeps
 * the `$or` out of the filter entirely, so the no-search case stays a pure indexed query.
 */
function normaliseSearch(search?: string | null): string | undefined {
	if (search === undefined || search === null) {
		return undefined
	}

	const term = search.trim()

	if (term.length === 0) {
		return undefined
	}

	if (term.length > SHOP_OWNERS_TBL_MAX_SEARCH_LENGTH) {
		throwErrorWrongUserInput(`search must be at most ${SHOP_OWNERS_TBL_MAX_SEARCH_LENGTH} characters`)
	}

	return term
}

/**
 * Rejects paging arguments outside the range the server is willing to serve.
 *
 * GraphQLInt already guarantees these are integers, so only the ranges are checked here. `offset`
 * has no upper bound on purpose — a large skip is slow but correct, and capping it would make the
 * last pages of a big result set unreachable.
 */
function assertPaging(offset: number, limit: number): void {
	if (offset < 0) {
		throwErrorWrongUserInput('offset must be 0 or greater')
	}

	if (limit < 1) {
		throwErrorWrongUserInput('limit must be 1 or greater')
	}

	if (limit > SHOP_OWNERS_TBL_MAX_LIMIT) {
		throwErrorWrongUserInput(`limit must be at most ${SHOP_OWNERS_TBL_MAX_LIMIT}`)
	}
}

/**
 * Builds the sort document, always ending in `_id`.
 *
 * ONE direction is applied to every component, including `_id`. That uniformity is what lets a
 * single compound index serve both ASC and DESC (an index satisfies a sort or its complete inverse,
 * nothing in between) — and the `_id` tail is what makes offset paging stable, because equal-keyed
 * documents otherwise come back in an order MongoDB is free to vary between the two queries, so a
 * row can show up on two pages while another is skipped.
 */
function buildSort(sortBy: ShopOwnersTblSortField, sortDir: ShopOwnersTblSortDirection): Record<string, 1 | -1> {
	const order = SORT_ORDERS[sortDir]
	const sort: Record<string, 1 | -1> = {}

	for (const path of SORT_PATHS[sortBy]) {
		sort[path] = order
	}

	sort._id = order

	return sort
}

/**
 * The filter. `trusted()` on the `$exists` values is mandatory: mongoose runs `sanitizeFilter`
 * globally (koa-utils enables it on the connection), which rewrites any un-trusted object holding
 * `$`-prefixed keys into `{ $eq: <object> }` — turning "field is absent" into "field equals the
 * literal document `{$exists: false}`", which matches nothing and would quietly return an empty
 * table. The `$or` branch needs no such marking: `sanitizeFilter` recurses into `$or` and the
 * RegExp values it finds there carry no `$` keys of their own.
 */
function buildFilter(term: string | undefined): QueryFilter<IShopOwnerModel> {
	return {
		disabled: trusted({ $exists: false }),
		deleted: trusted({ $exists: false }),
		...(term === undefined ? {} : { $or: SEARCHABLE_PATHS.map((path) => ({ [path]: prefixRegExp(term) })) })
	}
}

/**
 * One page of active shopOwners plus the size of the filtered set.
 *
 * The two database calls run concurrently. They are independent — the count does not read the page
 * — so awaiting them in sequence would add the count's latency to every request for nothing.
 */
export default async function shopOwnersActiveTblDb(args: IShopOwnersActiveTblArgs): Promise<IShopOwnersActiveTblPage> {
	assertPaging(args.offset, args.limit)

	const filter = buildFilter(normaliseSearch(args.search))

	const [items, total] = await Promise.all([
		ShopOwner.find(filter)
			.select(SHOP_OWNERS_TBL_SELECTION)
			.sort(buildSort(args.sortBy, args.sortDir))
			.skip(args.offset)
			.limit(args.limit)
			.lean(),
		ShopOwner.countDocuments(filter)
	])

	return { items, total }
}
