import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { IUserModel } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IUserModel'
import { QueryFilter, trusted } from 'mongoose'

/**
 * Server-side paging for the operator's customers table (E19-S02).
 *
 * ⚠️ **`shopOwnersActiveTblDb` with the `search` cut out, and the cut is the whole design.** `user` is
 * the collection encrypted whole (ADR-029): `personalData.firstName`, `personalData.lastName` and every
 * element of `addresses[]` — `city` included — are *randomly* encrypted, and random ciphertext preserves
 * nothing. No order, no range, no prefix. The sibling lib builds `/^term/i` over exactly those three
 * paths; the same code here would compare a name against base64, match zero rows for every term on every
 * account, and never error — a customer base that renders as empty. So there is no `search` argument and
 * `GraphQLUsersTblSortField` has one member. `phase5/epics/E19.md` E19-S05 is the anti-story that says
 * so, and what each way of closing the gap would break.
 *
 * Everything this query orders, filters or counts on was never encrypted: `registeredAt`, `deleted`,
 * `disabled`, `emailVerify.valid`. `login.email` is returned and never ordered — it is deterministic, so
 * the driver decrypts it on the way out and an *equality* lookup on it works, but its ciphertext order is
 * not alphabetical order and is not the operator's order either.
 */

export const USERS_TBL_DEFAULT_LIMIT = 25

/**
 * Hard server-side ceiling on `limit`. Without it the argument is a client-controlled way back to an
 * unbounded query — `limit: 1000000` would be honoured and the pagination would be decoration.
 */
export const USERS_TBL_MAX_LIMIT = 100

/**
 * The projection the GraphQL table type consumes. A field dropped here nulls a NonNull.
 *
 * ⚠️ **Nothing from `personalData`, nothing from `addresses[]`, and that is a decision rather than a
 * minimal first version.** Those are the fields an operator has no stated task for, R25 is still open,
 * and every one of them is ciphertext the driver would decrypt on the way out — projecting them would put
 * a customer's name and home address on a screen built to answer "which account is this support request
 * about". `login.email` is what identifies the row instead, and it is the one personal field here.
 *
 * `login.password` is absent for the reason it is absent on the shop-owner table: the projection is a
 * positive list and the credential is not on it.
 *
 * ⚠️ **`disabledReason` is the one exception to the paragraph above, and it is deliberate** (ADR-044). It
 * is ciphertext the driver decrypts on the way out, like a name would be — but it is the platform's own
 * record of why it acted, not the customer's data, and this table is the only customer surface an operator
 * has. Left off, a suspension is unanswerable: nothing else on any tier can read the field.
 */
export const USERS_TBL_SELECTION = '_id registeredAt login.email disabled disabledBy disabledReason deleted emailVerify.valid'

/**
 * GraphQL enum name → the Mongo paths to sort by, in order. `_id` is appended by `buildSort`, so the
 * entry below is the tie-broken prefix rather than the whole sort.
 *
 * ⚠️ **One entry, and the map shape is deliberate.** It is a map because `registeredAt` is the only clear
 * field on this collection worth ordering by and `tbl_active_registeredAt` is the only index `user` has
 * to serve it — not because a second column is planned. Adding `LAST_NAME` here the way the shop-owner
 * lib has it would order customers by ciphertext: stable, arbitrary, and indistinguishable from a working
 * sort until somebody checks it against the data.
 */
const SORT_PATHS = {
	REGISTERED_AT: ['registeredAt']
} as const

const SORT_ORDERS = { ASC: 1, DESC: -1 } as const

export type UsersTblSortField = keyof typeof SORT_PATHS
export type UsersTblSortDirection = keyof typeof SORT_ORDERS

export interface IUsersActiveTblArgs {
	offset: number
	limit: number
	disabled: boolean
	deleted: boolean
	emailVerified?: boolean | null
	sortBy: UsersTblSortField
	sortDir: UsersTblSortDirection
}

export interface IUsersActiveTblPage {
	items: unknown[]
	total: number
}

/**
 * Rejects paging arguments outside the range the server is willing to serve.
 *
 * GraphQLInt already guarantees these are integers, so only the ranges are checked. `offset` has no
 * upper bound on purpose — a large skip is slow but correct, and capping it would make the last pages of
 * a big result set unreachable.
 *
 * Spelled out here rather than shared with `shopOwnersActiveTblDb`: the two libs page two collections
 * with two ceilings of their own, and a shared bound would mean a limit raised for one table silently
 * raising it for the other.
 */
function assertPaging(offset: number, limit: number): void {
	if (offset < 0) {
		throwErrorWrongUserInput('offset must be 0 or greater')
	}

	if (limit < 1) {
		throwErrorWrongUserInput('limit must be 1 or greater')
	}

	if (limit > USERS_TBL_MAX_LIMIT) {
		throwErrorWrongUserInput(`limit must be at most ${USERS_TBL_MAX_LIMIT}`)
	}
}

/**
 * Builds the sort document, always ending in `_id`.
 *
 * ONE direction is applied to every component, `_id` included. That uniformity is what lets a single
 * compound index serve both ASC and DESC (an index satisfies a sort or its complete inverse, nothing in
 * between) — and the `_id` tail is what makes offset paging stable, because equal-keyed documents
 * otherwise come back in an order MongoDB is free to vary between two queries, so a document can appear
 * on two pages while another is skipped.
 */
function buildSort(sortBy: UsersTblSortField, sortDir: UsersTblSortDirection): Record<string, 1 | -1> {
	const order = SORT_ORDERS[sortDir]
	const sort: Record<string, 1 | -1> = {}

	for (const path of SORT_PATHS[sortBy]) {
		sort[path] = order
	}

	sort._id = order

	return sort
}

/**
 * The filter, keyed in the order `tbl_active_registeredAt` is: `deleted`, then `disabled`, then the sort.
 *
 * `trusted()` on every `$`-keyed value is mandatory: mongoose runs `sanitizeFilter` globally (koa-utils
 * enables it on the connection), which rewrites an un-trusted object holding `$`-prefixed keys into
 * `{ $eq: <object> }` — turning "field is absent" into "field equals the literal document
 * `{$exists: false}`", which matches nothing and would quietly return an empty table.
 *
 * ⚠️ **`disabled: true` is an equality and `deleted: true` is not, and the asymmetry is in the data
 * rather than in the code.** `disabled` is a flag stored as `true` or removed outright — the shape
 * `funShopOwnerUpdateStatus` already has and the one E19-S03 gives `user` — so both of its states are
 * point predicates and the index serves the sort either way. `deleted` is a *timestamp* (ADR-011), so
 * "is soft-deleted" can only be `$exists: true`, which is a range: MongoDB cannot turn a range on a
 * leading index field into a sorted scan, so that one page pays a blocking sort. It is bounded to the
 * soft-deleted subset and bounded again by the ceiling on `limit`, and the default page — the one an
 * operator lands on — is fully indexed.
 *
 * `emailVerify.valid` is the tri-state, and the only one: absent means "show both", because it is the
 * flag the operator *reads* off the row rather than narrows by. `false` is `$ne: true` rather than
 * `$eq: false` because an account that never asked for a confirmation link has no `valid` key at all —
 * `enableEmailAccess` is what writes it — so `{valid: false}` would answer "nobody is unverified" on
 * precisely the accounts that are. It is deliberately outside `tbl_active_registeredAt`, so it filters
 * what the index already bounded rather than choosing the scan.
 */
function buildFilter(args: IUsersActiveTblArgs): QueryFilter<IUserModel> {
	const verified = args.emailVerified

	return {
		deleted: args.deleted ? trusted({ $exists: true }) : trusted({ $exists: false }),
		disabled: args.disabled ? true : trusted({ $exists: false }),
		...(verified === undefined || verified === null ? {} : { 'emailVerify.valid': verified ? true : trusted({ $ne: true }) })
	}
}

/**
 * One page of customers plus the size of the filtered set.
 *
 * The two database calls run concurrently. They are independent — the count does not read the page — so
 * awaiting them in sequence would add the count's latency to every request for nothing. The same filter
 * OBJECT goes to both: two equal filters that could drift would make `total` describe a different set
 * than `items`, and the page count the operator sees would be wrong in a way no single page can show.
 */
export default async function usersActiveTblDb(args: IUsersActiveTblArgs): Promise<IUsersActiveTblPage> {
	assertPaging(args.offset, args.limit)

	const filter = buildFilter(args)

	const [items, total] = await Promise.all([
		User.find(filter)
			.select(USERS_TBL_SELECTION)
			.sort(buildSort(args.sortBy, args.sortDir))
			.skip(args.offset)
			.limit(args.limit)
			.lean(),
		User.countDocuments(filter)
	])

	return { items, total }
}
