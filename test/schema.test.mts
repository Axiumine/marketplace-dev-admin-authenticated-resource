import { getIntrospectionQuery, graphql, GraphQLSchema } from 'graphql'
import { describe, expect, it, vi } from 'vitest'

// The resolvers pull the models in transitively; nothing connects, but the Redis client is
// imported by the auth context type chain and needs a stub in the unit project.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: {} }))

type IntrospectedArg = { name: string; defaultValue: string | null }
type IntrospectedTypeRef = { kind: string; name: string | null; ofType: IntrospectedTypeRef | null }
type IntrospectedField = {
	name: string
	description: string | null
	args: IntrospectedArg[]
	type: IntrospectedTypeRef
}
type IntrospectedType = {
	name: string
	fields: IntrospectedField[] | null
	inputFields: Array<{ name: string }> | null
	enumValues: Array<{ name: string }> | null
}

let result: Awaited<ReturnType<typeof graphql>>
let types: Map<string, IntrospectedType>

// The module imports, the schema assembly AND the introspection run all live inside the first
// `it` below rather than at module top level or in a beforeAll: a mutant in queries.mts /
// mutations.mts (the two root schema files, both plain `new GraphQLObjectType({...})` calls,
// where graphql-js's assertName() throws on an empty/missing `name`) can only register as a kill
// if the throw happens while THAT test is running. Vitest turns a beforeAll throw into every
// descendant test reporting status "skipped", not "failed" — Stryker's coverage-perTest run reads
// that status directly, sees no failing test, and reports the mutant Survived even though the
// suite plainly errors. Importing at module top level has the identical problem one phase
// earlier, during Vitest's file-collection. An `it` body is the only scope whose own failure
// Stryker attributes to that specific test.
function fieldsOf(typeName: string): string[] {
	return (types.get(typeName)?.fields ?? []).map((f) => f.name)
}

/** Input object types expose `inputFields`, never `fields` — `fieldsOf` reads empty for all of them. */
function inputFieldsOf(typeName: string): string[] {
	return (types.get(typeName)?.inputFields ?? []).map((f) => f.name)
}

function enumValuesOf(typeName: string): string[] {
	return (types.get(typeName)?.enumValues ?? []).map((v) => v.name)
}

/**
 * A field's type exactly as introspection reports it, wrapper kinds and all.
 *
 * Rebuilt rather than handed back untouched because introspection pads the `ofType` chain out to seven
 * levels of `null`, and the whole chain is kept rather than one level unwrapped: a list or non-null
 * wrapper appearing further down would otherwise be dropped by the reader instead of failing the test.
 */
function typeOfField(typeName: string, fieldName: string): unknown {
	const chain = (ref: IntrospectedTypeRef | null): unknown =>
		ref === null ? null : { kind: ref.kind, name: ref.name, ofType: chain(ref.ofType) }

	return chain(types.get(typeName)?.fields?.find((f) => f.name === fieldName)?.type ?? null)
}

function argsOf(typeName: string, fieldName: string): IntrospectedArg[] {
	return types.get(typeName)?.fields?.find((f) => f.name === fieldName)?.args ?? []
}

describe('schema', () => {
	it('assembles without a single validation error', async () => {
		const { default: QueriesApi } = await import('../src/graphQLApi/schema/queries.mts')
		const { default: MutationsApi } = await import('../src/graphQLApi/schema/mutations.mts')

		const schema = new GraphQLSchema({ query: QueriesApi, mutation: MutationsApi })

		// One real introspection run: it validates the assembled schema AND forces every
		// `fields: () => ({...})` thunk in the type files, which is what actually covers them.
		result = await graphql({ schema, source: getIntrospectionQuery() })
		const introspection = result.data?.__schema as unknown as { types: IntrospectedType[] }
		types = new Map(introspection.types.map((t) => [t.name, t]))

		expect(result.errors).toBeUndefined()
	})

	it('exposes the twelve admin queries', () => {
		expect(fieldsOf('QueriesApi')).toEqual([
			'infoAdminAfterLogin',
			'shopOwnersActiveTbl',
			'shopOwnersStats',
			'shopOwnersPerPeriod',
			'shopOwnerById',
			'shopOwnerCompanies',
			'usersActiveTbl',
			'companyItems',
			'itemCategories',
			'keygripStatus',
			'sessions',
			'reuseEvents'
		])
	})

	it('exposes the twenty-two mutations', () => {
		expect(fieldsOf('MutationsApi')).toEqual([
			'adminUpdatePwd',
			'shopOwnerAdd',
			'shopOwnerDel',
			'shopOwnerUpdate',
			'shopOwnerUpdateEmail',
			'shopOwnerUpdateNote',
			'shopOwnerUpdatePreferences',
			'shopOwnerUpdateStatus',
			'userUpdateStatus',
			'companyAdd',
			'companyDel',
			'companyUpdate',
			'companyUpdatePublished',
			'itemCategoryAdd',
			'itemCategoryDel',
			'itemCategoryUpdate',
			'itemDel',
			'itemUpdatePublished',
			'keygripRotate',
			'keygripRetire',
			'revokeSession',
			'revokeAllSessions'
		])
	})

	// The operator writes the taxonomy and moderates items; it never authors one. `itemAdd` and
	// `itemUpdate` live on 4026 only, and their absence here is the tier boundary — an operator with a
	// way to write an item into somebody's catalogue is a different product.
	it('gives the operator no way to author an item', () => {
		expect(fieldsOf('MutationsApi')).not.toContain('itemAdd')
		expect(fieldsOf('MutationsApi')).not.toContain('itemUpdate')
	})

	it.each([
		['adminUpdatePwd', ['passwordOld', 'passwordNew'], 'updates the password of the signed-in admin account'],
		['shopOwnerAdd', ['login', 'personalData'], 'adds a shopOwner'],
		['shopOwnerDel', ['_id'], 'deletes a shopOwner'],
		['shopOwnerUpdate', ['_id', 'personalData'], 'updates a shopOwner'],
		['shopOwnerUpdateEmail', ['_id', 'email'], 'updates the login email of the shopOwner'],
		['shopOwnerUpdateNote', ['_id', 'notes'], 'updates the internal note about the shopOwner'],
		[
			'shopOwnerUpdatePreferences',
			['_id', 'rememberMe', 'onboardingDone', 'onboardingStep'],
			'updates the login preferences of the shopOwner'
		],
		// ⚠️ `disabledReason` is the one nullable argument on either status mutation, and it is nullable
		// because its requirement is conditional — mandatory beside `disabled: true`, meaningless beside
		// `disabled: false` — which graphql-js cannot express. `validateDisabledReason` is the whole
		// contract for it; making it `String!` here would make releasing an account impossible without
		// inventing a reason for it.
		[
			'shopOwnerUpdateStatus',
			['_id', 'disabled', 'waitApprov', 'disabledReason'],
			'updates the status of the shopOwner account'
		],
		// ⚠️ Three arguments where the shop owner's takes four, and the missing one is not an omission:
		// `user` gets no approval gate, ever (`phase5/CUSTOMER_ACCOUNT_ADDRESSES.md` §6). A `waitApprov` here would be a lever
		// nothing on the customer's own tier reads.
		['userUpdateStatus', ['_id', 'disabled', 'disabledReason'], 'updates the status of the user account'],
		// `idShopOwner` sits beside the input object on the create, and is absent from the update: a
		// company cannot be handed to another owner by saving its card. The schema is where that is
		// enforced — the resolver never sees an argument the type system does not declare.
		['companyAdd', ['idShopOwner', 'company'], 'adds a company to a shopOwner'],
		['companyDel', ['_id'], 'deletes a company'],
		['companyUpdate', ['_id', 'company'], 'updates a company'],
		// The flag beside the `_id` and nothing else, exactly like `itemUpdatePublished`: publishing a shop
		// is its own operation, not a save of the card with one box ticked.
		['companyUpdatePublished', ['_id', 'published'], 'publishes or unpublishes a company'],
		['itemCategoryAdd', ['itemCategory'], 'adds an item category'],
		['itemCategoryDel', ['_id'], 'deletes an item category'],
		['itemCategoryUpdate', ['_id', 'itemCategory'], 'updates an item category'],
		['itemDel', ['_id'], 'deletes an item'],
		// Two arguments and no input object: moderation flips one flag, and the shape says so.
		['itemUpdatePublished', ['_id', 'published'], 'publishes or unpublishes an item'],
		// ⚠️ No arguments at all, and that is the security property (ADR-034): what the new key is, and
		// which version it lands under, are read from the record and decided by the platform. An argument
		// here — key material, a version, a count — would be a way to install a chosen signing key, which
		// is the ability to mint a session cookie for any account on the platform.
		[
			'keygripRotate',
			[],
			'mints a new cookie-signing key for the whole platform and retires the ones nothing can still be signed with'
		],
		// ⚠️ One argument, and it is an id — the public half of a key, rendered by `keygripStatus` and the
		// thing the fingerprint is computed over. Key material and a version are absent for the same reason
		// they are absent from `keygripRotate`: either would be a way to decide what the record ends up
		// holding, rather than which of the keys it already holds is dropped.
		[
			'keygripRetire',
			['id'],
			'drops one cookie-signing key from the whole platform, logging out everyone whose cookie it signed'
		]
	])('%s takes the arguments the resolver reads', (name, expected, description) => {
		const field = types.get('MutationsApi')?.fields?.find((f) => f.name === name)
		expect(field?.args.map((a) => a.name)).toEqual(expected)
		expect(field?.description).toBe(description)
	})

	// Asserted as an absence, because the absence is the security property: `adminUpdatePwd` takes
	// no id of any kind. The account it changes is the one the Redis session names, so an argument
	// added here would immediately be a way to set another operator's password — every admin
	// authenticates against the same collection and there is no role field to stop it.
	it('gives adminUpdatePwd no way to name the account it changes', () => {
		expect(argsOf('MutationsApi', 'adminUpdatePwd').map((a) => a.name)).not.toContain('_id')
	})

	it.each([
		['shopOwnerCompanies', ['idShopOwner'], 'Get the companies of a shopOwner'],
		['companyItems', ['idCompany'], 'Get the items of a company'],
		// No arguments at all: the taxonomy is bounded by hand and the screen renders it whole.
		['itemCategories', [], 'Get all the item categories'],
		['shopOwnerById', ['idShopOwner'], 'Get a shopOwner by id'],
		['shopOwnersActiveTbl', ['offset', 'limit', 'search', 'sortBy', 'sortDir'], 'Get shopOwners for the table'],
		// Seven arguments where the shop-owner table has five: no `search` (E19-S05), and three filters
		// where that one hard-codes `disabled`/`deleted` into its filter. The absence of `search` is
		// asserted by this list being exact.
		[
			'usersActiveTbl',
			['offset', 'limit', 'disabled', 'deleted', 'emailVerified', 'sortBy', 'sortDir'],
			'Get users for the table'
		],
		['shopOwnersPerPeriod', ['period'], 'Time series of registered shopOwners'],
		['shopOwnersStats', [], 'ShopOwners stats'],
		['infoAdminAfterLogin', [], 'Info after login'],
		// ⚠️ No arguments, for the same reason `keygripRotate` has none (ADR-034): this reads the record
		// that is live right now. A `version` argument would be a request to unwrap an older blob, and the
		// platform keeps none — the rotation replaces all three fields at once.
		['keygripStatus', [], 'Get the current cookie-signing key set and which services are holding it']
	])('%s takes the arguments the resolver reads', (name, expected, description) => {
		const field = types.get('QueriesApi')?.fields?.find((f) => f.name === name)
		expect(field?.args.map((a) => a.name)).toEqual(expected)
		expect(field?.description).toBe(description)
	})
})

describe('shopOwnersActiveTbl paging contract', () => {
	// The defaults are part of the public contract: a client that sends none of these still gets a
	// bounded page, which is the whole reason the unbounded list query could be removed. Read from
	// the assembled schema rather than from the resolver's source, so the constant the resolver
	// imports for `limit` is checked at the value it actually reaches the client with.
	it('defaults to the newest 25, and to no search', () => {
		const defaults = Object.fromEntries(argsOf('QueriesApi', 'shopOwnersActiveTbl').map((a) => [a.name, a.defaultValue]))

		expect(defaults).toEqual({
			offset: '0',
			limit: '25',
			// null, not a string: `search` is the one nullable argument, because "not searching" is a
			// real state of the table and a distinct one from searching for the empty string.
			search: null,
			sortBy: 'REGISTERED_AT',
			sortDir: 'DESC'
		})
	})

	// `sortBy` becomes a key of the Mongo sort document. Enumerating it is what stops a caller from
	// ordering by an arbitrary field — every value below has a matching index in marketplace-db-setup,
	// and a free String here would let anyone turn the query into a blocking in-memory sort.
	it('offers exactly the four sortable columns and two directions', () => {
		expect(enumValuesOf('GraphQLShopOwnersTblSortField')).toEqual(['REGISTERED_AT', 'FIRST_NAME', 'LAST_NAME', 'CITY'])
		expect(enumValuesOf('GraphQLSortDirection')).toEqual(['ASC', 'DESC'])
	})

	it('returns a page, not a list', () => {
		expect(fieldsOf('GraphQLShopOwnersActiveTblPage')).toEqual(['items', 'total'])
	})
})

describe('usersActiveTbl paging contract', () => {
	// ⚠️ The defaults are the answer to "what does an operator see on arrival" (E19.md §6, question 5),
	// and they are read from the assembled schema rather than from the resolver's source, so what is
	// checked is what a client sending nothing actually gets: the newest 25 live, enabled customers,
	// verified or not.
	it('defaults to the newest 25 live, enabled accounts', () => {
		const defaults = Object.fromEntries(argsOf('QueriesApi', 'usersActiveTbl').map((a) => [a.name, a.defaultValue]))

		expect(defaults).toEqual({
			offset: '0',
			limit: '25',
			disabled: 'false',
			deleted: 'false',
			// null, not 'false': the one nullable argument, because "do not filter on it" is a real
			// state of this table and a distinct one from "show me the unverified". It is nullable
			// precisely because it is the filter OUTSIDE `tbl_active_registeredAt` — the other two are
			// the index's leading fields and every page has to name one state of each.
			emailVerified: null,
			sortBy: 'REGISTERED_AT',
			sortDir: 'DESC'
		})
	})

	// ⚠️ **Exactly one member, and this is the assertion that keeps it one** (E19-S05). `sortBy` becomes
	// a key of the Mongo sort document; on `user` the names and the city are randomly encrypted, so a
	// second member here would order the customer base by ciphertext — an order that is stable,
	// arbitrary, and looks exactly like a working sort until somebody checks it against the data.
	it('offers exactly one sortable column, and reuses the shared direction enum', () => {
		expect(enumValuesOf('GraphQLUsersTblSortField')).toEqual(['REGISTERED_AT'])
		expect(enumValuesOf('GraphQLSortDirection')).toEqual(['ASC', 'DESC'])
	})

	it('returns a page, not a list', () => {
		expect(fieldsOf('GraphQLUsersActiveTblPage')).toEqual(['items', 'total'])
	})

	// ⚠️ The row is the epic's boundary in one line: the login address and three flags, and **nothing
	// from `personalData` or `addresses[]`**. Asserted exactly, so a name or a city column added to the
	// type fails here before it reaches a screen — every one of those fields is ciphertext the driver
	// decrypts on the way out, and this tier has no stated task for any of them (ADR-029, R25).
	it('GraphQLUserActiveTbl carries the address and the flags, and no other personal field', () => {
		expect(fieldsOf('GraphQLUserActiveTbl')).toEqual([
			'_id',
			'registeredAt',
			'email',
			'disabled',
			'disabledBy',
			'disabledReason',
			'deleted',
			'emailVerified'
		])
	})

	// `deleted` is a timestamp and not a flag (ADR-011), while the query's `deleted` ARGUMENT is a
	// Boolean. The two spellings of one word are the reason this is pinned: a `Boolean` here would
	// read as correct and hand the frontend `true` for a date it has to render.
	it('reports deleted as the timestamp it is, and the two flags as nullable Booleans', () => {
		expect(typeOfField('GraphQLUserActiveTbl', 'deleted')).toEqual({ kind: 'SCALAR', name: 'DateTime', ofType: null })
		expect(typeOfField('GraphQLUserActiveTbl', 'disabled')).toEqual({ kind: 'SCALAR', name: 'Boolean', ofType: null })
		expect(typeOfField('GraphQLUserActiveTbl', 'emailVerified')).toEqual({ kind: 'SCALAR', name: 'Boolean', ofType: null })
	})

	// The two fields on this row with resolvers of their own, so the two introspection cannot check:
	// every other field is answered by the default resolver reading a same-named key. The document
	// nests both, the table renders two flat columns, and a resolver returning the row itself — or a
	// constant — still introspects as `String!` / `Boolean`.
	it('flattens login.email and emailVerify.valid onto the row', async () => {
		const { GraphQLUserActiveTbl } = await import('../src/graphQLApi/schema/types/GraphQLUserActiveTbl.mts')

		const fields = GraphQLUserActiveTbl.getFields()
		const row = { login: { email: 'customer@example.com' }, emailVerify: { valid: true } }

		expect(fields.email.resolve?.(row, {}, undefined, undefined as never)).toBe('customer@example.com')
		expect(fields.emailVerified.resolve?.(row, {}, undefined, undefined as never)).toBe(true)

		// ⚠️ The unconfirmed account, which is the majority state of a fresh registration:
		// `enableEmailAccess` is what writes `valid`, so until it runs there is no `emailVerify` object
		// at all. Without the optional chain this row is a TypeError that fails the WHOLE page — `items`
		// is a non-null list of non-null rows — for every customer who has not clicked the link yet.
		expect(fields.emailVerified.resolve?.({ login: { email: 'x@y.z' } }, {}, undefined, undefined as never)).toBeUndefined()
	})
})

describe('shopOwnersPerPeriod contract', () => {
	// `ALL` is the default because it is the only range that answers "how did we get here" without
	// the caller already knowing the shape of the data. Read from the assembled schema, so what is
	// checked is the value a client that sends no argument actually gets.
	it('defaults to the whole history', () => {
		const defaults = Object.fromEntries(argsOf('QueriesApi', 'shopOwnersPerPeriod').map((a) => [a.name, a.defaultValue]))

		expect(defaults).toEqual({ period: 'ALL' })
	})

	// Enumerated for the same reason `sortBy` is: the value picks a range start AND a bucket width,
	// so a free Int here would let a caller ask for a hundred years of day buckets — one `$group` per
	// day, gap-filled into an array the browser then has to draw.
	it('offers exactly the three ranges', () => {
		expect(enumValuesOf('GraphQLShopOwnersPeriod')).toEqual(['ALL', 'THREE_MONTHS', 'ONE_MONTH'])
	})

	// Reported, never requested — there is no `granularity` argument anywhere. The bucket width is a
	// consequence of the range, and this is the assertion that keeps it one.
	it('reports the granularity it chose, and takes no say in it', () => {
		expect(fieldsOf('GraphQLShopOwnersPerPeriod')).toEqual(['granularity', 'points'])
		expect(enumValuesOf('GraphQLPeriodGranularity')).toEqual(['DAY', 'MONTH'])
		expect(argsOf('QueriesApi', 'shopOwnersPerPeriod').map((a) => a.name)).not.toContain('granularity')
	})

	it('carries a bucket key and a count per point', () => {
		expect(fieldsOf('GraphQLShopOwnersPerPeriodPoint')).toEqual(['date', 'total'])
	})
})

describe('object types', () => {
	it('GraphQLAdminInfoAfterLogin carries the session identity', () => {
		expect(fieldsOf('GraphQLAdminInfoAfterLogin')).toEqual(['_id', 'email'])
	})

	it('GraphQLShopOwnerById mirrors the projection of its query', () => {
		expect(fieldsOf('GraphQLShopOwnerById')).toEqual([
			'_id',
			'login',
			'personalData',
			'registeredAt',
			'deleted',
			'disabled',
			'disabledBy',
			'disabledReason',
			'waitApprov',
			'notes',
			'resetPwd'
		])
		expect(fieldsOf('GraphQLShopOwnerLogin')).toEqual([
			'email',
			'firstLogin',
			'lastLogin',
			'onboardingStep',
			'onboardingDone',
			'rememberMe'
		])
		expect(fieldsOf('GraphQLShopOwnerPersonalDataById')).toEqual(['firstName', 'lastName', 'address', 'birth', 'contacts'])
		expect(fieldsOf('GraphQLShopOwnerContacts')).toEqual(['email', 'landline', 'mobile'])
		expect(fieldsOf('GraphQLResetPwd')).toEqual(['resetDateReq', 'resetHash'])
		expect(fieldsOf('GraphQLBirth')).toEqual(['date'])
	})

	it('GraphQLShopOwnerActiveTbl stays a narrow table projection', () => {
		expect(fieldsOf('GraphQLShopOwnerActiveTbl')).toEqual(['_id', 'registeredAt', 'email', 'personalData', 'waitApprov'])
		expect(fieldsOf('GraphQLPersonalData')).toEqual(['firstName', 'lastName', 'address'])
	})

	// ⚠️ **`personalData` is nullable on both shopOwner types, and introspection is where that is
	// pinned.** It stopped being required on the collection when `shopOwnerRegister` shipped: a
	// self-registered seller has an address and a password and nothing else until onboarding. A
	// `NonNull` here would not merely null one field — `items` is a non-null list of non-null rows, so
	// one pending registration turns the operator's whole table into an error, and the detail page into
	// a 500 for exactly the account the operator opened it to approve.
	it.each([
		['GraphQLShopOwnerActiveTbl', 'GraphQLPersonalData'],
		['GraphQLShopOwnerById', 'GraphQLShopOwnerPersonalDataById']
	])('leaves personalData nullable on %s, for accounts that have none yet', (owner, personalData) => {
		expect(typeOfField(owner, 'personalData')).toEqual({ kind: 'OBJECT', name: personalData, ofType: null })
	})

	// The queue's two columns. `email` is what identifies a row whose `personalData` is absent, and
	// `waitApprov` is what marks it as waiting — nullable because the field is `$unset` on approval and
	// so reads as absent, never `false`.
	it('carries the approval queue on the table type', () => {
		expect(typeOfField('GraphQLShopOwnerActiveTbl', 'email')).toEqual({
			kind: 'NON_NULL',
			name: null,
			ofType: { kind: 'SCALAR', name: 'String', ofType: null }
		})
		expect(typeOfField('GraphQLShopOwnerActiveTbl', 'waitApprov')).toEqual({
			kind: 'SCALAR',
			name: 'Boolean',
			ofType: null
		})
	})

	// The one field on this schema with a resolver of its own, so the one that introspection cannot
	// check: every other field is answered by the default resolver reading a same-named key. The
	// document nests the address under `login` and the table renders it as a flat column, and nothing
	// above this line would notice the mapping being wrong — a resolver returning the row itself, or a
	// constant, still introspects as `String!`.
	it('flattens login.email onto the row', async () => {
		const { GraphQLShopOwnerActiveTbl } = await import('../src/graphQLApi/schema/types/GraphQLShopOwnerActiveTbl.mts')

		const { resolve } = GraphQLShopOwnerActiveTbl.getFields().email
		const row = { login: { email: 'seller@example.com' } }

		expect(resolve?.(row, {}, undefined, undefined as never)).toBe('seller@example.com')
	})

	// Both address types spread the same shared fragment from marketplace-common, so the four address
	// fields must stay identical — a drift there means the fragment was edited in one place only. The
	// detail type carries one field more: the table never draws a map, so it does not ask for the point.
	it('spreads the shared address fragment in both address types', () => {
		const table = fieldsOf('GraphQLShopOwnerAddressTbl')
		expect(table.length).toBeGreaterThan(0)
		expect(fieldsOf('GraphQLShopOwnerAddress')).toEqual([...table, 'position'])
	})

	// ⚠️ Nullable here, non-null on the company seat. Every shopOwner stored before
	// 20260802000300-alter-shopOwner-position-note has an address and no coordinates, and there is
	// nothing to derive them from — a GraphQLNonNull would turn each of those accounts into a query
	// that errors instead of a map that is simply not drawn yet. The wrapper `kind` is what is
	// asserted, not just the name: a name-only check reads the same on both shapes, which is the
	// mistake this pins.
	it('leaves the shopOwner point nullable, unlike the company one', () => {
		expect(typeOfField('GraphQLShopOwnerAddress', 'position')).toEqual({
			kind: 'OBJECT',
			name: 'GraphQLPositionShopOwner',
			ofType: null
		})
		expect(typeOfField('GraphQLCompanyAddress', 'position')).toEqual({
			kind: 'NON_NULL',
			name: null,
			ofType: { kind: 'OBJECT', name: 'GraphQLCompanyPosition', ofType: null }
		})
	})

	it('carries the same point shape on both, once unwrapped', () => {
		expect(fieldsOf('GraphQLPositionShopOwner')).toEqual(fieldsOf('GraphQLCompanyPosition'))
		expect(fieldsOf('GraphQLPositionShopOwner').length).toBeGreaterThan(0)
	})

	it('GraphQLCompany carries the company, its owner and its legal seat', () => {
		// `idShopOwner` is second, right after the id: it is the field every read of a company is
		// scoped by, and the operator app reaches one only through its owner's page.
		expect(fieldsOf('GraphQLCompany')).toEqual([
			'_id',
			'idShopOwner',
			'legalName',
			'vatNumber',
			'taxCode',
			'contactPerson',
			'administrator',
			'uniqueCode',
			'certifiedEmail',
			'address',
			'registryExtract',
			// The shop-listing half, added with the catalogue: `legalName` is a legal instrument and is
			// the wrong thing to print on a card, so the trading name is its own field.
			'publicName',
			'slug',
			'description',
			'published'
		])
		// Same shared fragment as the shopOwner's address, so the four base fields cannot drift apart. The
		// position is non-null here and nullable there: unlike the shopOwner's, every company seat is
		// geocoded at creation because the collection has no documents predating the requirement.
		expect(fieldsOf('GraphQLCompanyAddress')).toEqual(fieldsOf('GraphQLShopOwnerAddress'))
		expect(typeOfField('GraphQLCompanyAddress', 'position')).toEqual({
			kind: 'NON_NULL',
			name: null,
			ofType: { kind: 'OBJECT', name: 'GraphQLCompanyPosition', ofType: null }
		})
	})

	// The nullable fields, and the only ones. They mirror the collection's `required` array — `taxCode`
	// did not exist before the extraction, so no stored company carries one, and a GraphQLNonNull on
	// either would turn every one of those documents into a query that errors. The three public fields are
	// nullable for the same reason: they were added to a populated collection, and `collMod` does not
	// re-validate stored documents, so requiring them would have taken a widen → backfill → narrow of
	// data nobody has written yet. `published` is the exception — the migration backfilled it `false`
	// on every existing document in the same step, which is what makes it safe to require.
	it('leaves taxCode, uniqueCode and the three public fields nullable, and nothing else', () => {
		const nonNull = (types.get('GraphQLCompany')?.fields ?? []).filter((f) => f.type.kind !== 'NON_NULL').map((f) => f.name)

		expect(nonNull).toEqual(['taxCode', 'uniqueCode', 'publicName', 'slug', 'description'])
	})

	// Flat: `idCategory` is an id and not a nested category object, because the operator's screen loads
	// the taxonomy once with `itemCategories` and joins client-side. A resolver-level join would run one
	// lookup per item on a list that can be a whole shop's catalogue.
	it('GraphQLItem carries the item, its company and its category', () => {
		expect(fieldsOf('GraphQLItem')).toEqual(['_id', 'idCompany', 'idCategory', 'name', 'description', 'slug', 'published'])
	})

	// Nothing on an item is optional, and that is the collection's `required` array showing through: an
	// item with no name or no category cannot be listed, filtered or linked to, so there is no half-built
	// state worth storing.
	it('leaves nothing on an item nullable', () => {
		const nullable = (types.get('GraphQLItem')?.fields ?? []).filter((f) => f.type.kind !== 'NON_NULL').map((f) => f.name)

		expect(nullable).toEqual([])
	})

	it('GraphQLKeygripStatus carries the record and who is holding it', () => {
		expect(fieldsOf('GraphQLKeygripStatus')).toEqual(['version', 'fingerprint', 'keys', 'holders'])
		// Ids and dates, no material — see the absence assertion below. `ageDays` is the key's own age,
		// computed by the server because every keygrip decision is taken against the server's clock.
		expect(fieldsOf('GraphQLKeygripKeyInfo')).toEqual(['id', 'createdAt', 'ageDays'])
		// `current` is answered server-side against the record the same read returned, so a row cannot be
		// compared against a fingerprint a rotation apart from the one shown above it.
		expect(fieldsOf('GraphQLKeygripHolder')).toEqual(['service', 'fingerprint', 'lastSeen', 'current'])
	})

	/*
	 * ⚠️ **The security property of the whole status screen, asserted by name rather than by snapshot**
	 * (ADR-034, E01-S14). The record these types describe holds the platform's cookie-signing keys, and an
	 * operator who could read one back could sign a session cookie for any account — a strictly larger
	 * power than "may rotate the keys", which is the only one this screen exists to grant.
	 *
	 * By name, because a snapshot test answers a field added later by asking to be updated, and the update
	 * looks like every other one. This list fails instead, and names what it refused.
	 *
	 * What is left is safe by construction: the key **ids** are counters, `createdAt` holds dates, and the
	 * fingerprint is a sha256 over the ordered ids — `keygripFingerprint` takes the ids precisely so that
	 * publishing it narrows a 64-byte secret by not one bit.
	 */
	it.each(['GraphQLKeygripStatus', 'GraphQLKeygripKeyInfo', 'GraphQLKeygripHolder'])(
		'exposes no key material on %s',
		(typeName) => {
			const fields = fieldsOf(typeName)

			expect(fields.length).toBeGreaterThan(0)
			for (const banned of ['material', 'wrapped', 'secret', 'kek', 'key', 'signingKey', 'keygrip'])
				expect(fields).not.toContain(banned)
		}
	)

	// Nothing on this screen is optional: every field is read out of a record that either opened or threw,
	// so there is no half-answered state — a nullable field here would be a way to render "unknown" for a
	// fingerprint an operator is about to compare by eye.
	it('leaves nothing on the keygrip status nullable', () => {
		const nullable = ['GraphQLKeygripStatus', 'GraphQLKeygripKeyInfo', 'GraphQLKeygripHolder'].flatMap((t) =>
			(types.get(t)?.fields ?? []).filter((f) => f.type.kind !== 'NON_NULL').map((f) => `${t}.${f.name}`)
		)

		expect(nullable).toEqual([])
	})

	it('GraphQLSession carries the row and nothing a token or an address could hide in', () => {
		expect(fieldsOf('GraphQLSession')).toEqual(['id', 'tier', 'mintedAt', 'familyId'])
	})

	it('GraphQLReuseEvent mirrors IReuseEvent field for field', () => {
		expect(fieldsOf('GraphQLReuseEvent')).toEqual(['familyId', 'tier', 'accountId', 'action', 'at'])
	})

	/*
	 * ⚠️ **The security property of the session console, asserted by name rather than by snapshot** (BCON-01,
	 * E17 §2). Two separate rules are being held here at once, and both are absolute.
	 *
	 * No token: `id` is the session index field — the SHA-256 of a *prefixed* refresh token — and a digest
	 * of a 128-bit random value is not invertible. `familyId` is a lineage handle that authenticates
	 * nothing. A field named for a token, a cookie or a secret would be a credential on a screen, which the
	 * user made a condition of this epic existing.
	 *
	 * Nothing network- or device-derived: no address, not truncated, not hashed, not salted — the standing
	 * decision on session rows. The answer to "was this session used from somewhere strange" on this
	 * platform is not available, deliberately; the answer to a compromise report is to end the sessions.
	 *
	 * By name, because a snapshot test answers a field added later by asking to be updated, and the update
	 * looks like every other one. This list fails instead, and names what it refused.
	 */
	it.each(['GraphQLSession', 'GraphQLReuseEvent'])('exposes no credential and nothing network-derived on %s', (typeName) => {
		const fields = fieldsOf(typeName)

		expect(fields.length).toBeGreaterThan(0)
		for (const banned of [
			'token',
			'refreshToken',
			'accessToken',
			'cookie',
			'secret',
			'hash',
			'digest',
			'ip',
			'ipAddress',
			'remoteAddress',
			'userAgent',
			'device',
			'location'
		])
			expect(fields).not.toContain(banned)
	})

	// Nothing on a session row or a trail line is optional: every field is read out of a record that either
	// existed or was dropped from the list entirely, so there is no half-answered state to render.
	it('leaves nothing on the session console nullable', () => {
		const nullable = ['GraphQLSession', 'GraphQLReuseEvent'].flatMap((t) =>
			(types.get(t)?.fields ?? []).filter((f) => f.type.kind !== 'NON_NULL').map((f) => `${t}.${f.name}`)
		)

		expect(nullable).toEqual([])
	})

	/*
	 * E17-S01: the generated union `marketplace-admin` renders from and the runtime values the backend
	 * writes into Redis are the same set, because both are `REUSE_EVENT_ACTIONS`. A hand-written enum on
	 * either side would drift the moment a third case is added, and the drift would surface as an operator
	 * reading a blank cell rather than as a failing build.
	 */
	it('GraphQLReuseEventAction holds exactly the shared action list', async () => {
		const { REUSE_EVENT_ACTIONS } = await import('@axiumine/marketplace-common/others/ReuseEventAction')

		expect(enumValuesOf('GraphQLReuseEventAction')).toEqual([...REUSE_EVENT_ACTIONS])
	})

	// The same rule one layer down: a tier this enum accepted and `sessionIndexKey` did not would name a key
	// that has never existed, and the console would answer "no sessions" for an account holding several.
	it('GraphQLTier holds exactly the tiers the key builders know', async () => {
		const { TIER } = await import('@axiumine/marketplace-common/others/Tier')

		expect(enumValuesOf('GraphQLTier')).toEqual(Object.values(TIER))
	})

	/*
	 * Both halves of the account on every console field, and the tier is an enum on all four: a query by id
	 * alone could list — and then end — a stranger's sessions, since ids come from three collections that
	 * can collide.
	 *
	 * ⚠️ **The description is asserted with the arguments, not as decoration.** These four are the only
	 * fields on the operator surface that end a credential, and the text here is what an operator reads in
	 * a schema explorer before deciding to fire one — `revokeAllSessions` saying it ends *every* session is
	 * the blast radius, and a rewrite that softened it would change what an operator believes they are
	 * about to do while changing nothing a behavioural test can see.
	 */
	it.each([
		['QueriesApi', 'sessions', ['tier', 'accountId'], 'List the live sessions one account holds'],
		[
			'QueriesApi',
			'reuseEvents',
			['tier', 'accountId'],
			'Read the trail of lineages this account has had revoked, newest first'
		],
		['MutationsApi', 'revokeSession', ['tier', 'accountId', 'id'], 'ends one session of one account and stops it being listed'],
		[
			'MutationsApi',
			'revokeAllSessions',
			['tier', 'accountId'],
			'ends every session one account holds and answers how many there were'
		]
	])('%s.%s names the account by tier and id', (root, field, expected, description) => {
		expect(argsOf(root, field).map((a) => a.name)).toEqual(expected)
		expect(typeOfField(root, field)).not.toBeNull()
		expect(types.get(root)?.fields?.find((f) => f.name === field)?.description).toBe(description)
	})

	// `idParent` is the one nullable field, and the nullability IS the tree: absent means top-level,
	// present means subcategory. A depth field or a `children` list would be a second encoding of the
	// same fact, free to disagree with this one.
	it('GraphQLItemCategory encodes the tree in a nullable idParent', () => {
		expect(fieldsOf('GraphQLItemCategory')).toEqual(['_id', 'idParent', 'name', 'slug', 'position'])

		const nullable = (types.get('GraphQLItemCategory')?.fields ?? [])
			.filter((f) => f.type.kind !== 'NON_NULL')
			.map((f) => f.name)

		expect(nullable).toEqual(['idParent'])
	})
})

describe('input types', () => {
	// The write shape of a company is the read shape minus the two fields the client does not get to
	// choose and the one that is a separate operation: `_id` is minted by the lib, `idShopOwner` is a
	// separate argument on the create and is nowhere at all on the update, and `published` is written by
	// `companyUpdatePublished` alone — a save of the card cannot carry it, and this assertion is what
	// stops it coming back. Derived from the output type rather than spelled out, so a field added to one
	// and forgotten on the other fails here instead of surfacing as a form that silently drops what the
	// operator typed.
	it('mirrors the company, minus the two fields the operator cannot set and the publish flag', () => {
		expect(inputFieldsOf('GraphQLInputCompany')).toEqual(
			fieldsOf('GraphQLCompany').filter((f) => f !== '_id' && f !== 'idShopOwner' && f !== 'published')
		)
		expect(inputFieldsOf('GraphQLInputCompanyAddress')).toEqual(fieldsOf('GraphQLCompanyAddress'))
	})

	// Asserted as an absence, like adminUpdatePwd's missing `_id` above. A GeoJSON `type` has exactly
	// one legal value here — the collection caps the field at 5 characters and the model declares it as
	// an enum of `['Point']` — so an input field for it could only ever carry the right answer or a
	// document that fails validation naming a field the operator never saw. The resolver writes the
	// literal instead; putting `type` back would silently hand that decision to the client.
	it('gives the position inputs no way to name a geometry other than Point', () => {
		expect(inputFieldsOf('GraphQLInputCompanyPosition')).toEqual(['coordinates'])
	})

	// The write shape of a category is the read shape minus `_id`, reordered so the two fields the
	// operator types come first. Spelled out rather than derived from `GraphQLItemCategory`, because
	// the orders genuinely differ and deriving it would only assert that they do not.
	it('takes a category as one object', () => {
		expect(inputFieldsOf('GraphQLInputItemCategory')).toEqual(['name', 'slug', 'idParent', 'position'])
	})

	// Asserted as an absence, like `adminUpdatePwd`'s missing `_id`. An operator moderates a catalogue,
	// it does not write one — so there is no input type for an item on this tier at all, and the two
	// item mutations here take scalars.
	it('gives the operator no input shape for an item', () => {
		expect(types.has('GraphQLInputItem')).toBe(false)
	})
})
