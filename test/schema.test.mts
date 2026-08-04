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

	it('exposes the six admin queries', () => {
		expect(fieldsOf('QueriesApi')).toEqual([
			'infoAdminAfterLogin',
			'shopOwnersActiveTbl',
			'shopOwnersStats',
			'shopOwnersPerPeriod',
			'shopOwnerById',
			'shopOwnerCompanies'
		])
	})

	it('exposes the eleven mutations', () => {
		expect(fieldsOf('MutationsApi')).toEqual([
			'adminUpdatePwd',
			'shopOwnerAdd',
			'shopOwnerDel',
			'shopOwnerUpdate',
			'shopOwnerUpdateEmail',
			'shopOwnerUpdateNote',
			'shopOwnerUpdatePreferences',
			'shopOwnerUpdateStatus',
			'companyAdd',
			'companyDel',
			'companyUpdate'
		])
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
		['shopOwnerUpdateStatus', ['_id', 'disabled', 'waitApprov'], 'updates the status of the shopOwner account'],
		// `idShopOwner` sits beside the input object on the create, and is absent from the update: a
		// company cannot be handed to another owner by saving its card. The schema is where that is
		// enforced — the resolver never sees an argument the type system does not declare.
		['companyAdd', ['idShopOwner', 'company'], 'adds a company to a shopOwner'],
		['companyDel', ['_id'], 'deletes a company'],
		['companyUpdate', ['_id', 'company'], 'updates a company']
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
		['shopOwnerById', ['idShopOwner'], 'Get a shopOwner by id'],
		['shopOwnersActiveTbl', ['offset', 'limit', 'search', 'sortBy', 'sortDir'], 'Get shopOwners for the table'],
		['shopOwnersPerPeriod', ['period'], 'Time series of registered shopOwners'],
		['shopOwnersStats', [], 'ShopOwners stats'],
		['infoAdminAfterLogin', [], 'Info after login']
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
		expect(fieldsOf('GraphQLShopOwnerActiveTbl')).toEqual(['_id', 'registeredAt', 'personalData'])
		expect(fieldsOf('GraphQLPersonalData')).toEqual(['firstName', 'lastName', 'address'])
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
			'registryExtract'
		])
		// Same shared fragment as the shopOwner's address, so the four base fields cannot drift apart. The
		// position is non-null here and nullable there: unlike the shopOwner's, every company seat is
		// geocoded at creation because the collection has no rows predating the requirement.
		expect(fieldsOf('GraphQLCompanyAddress')).toEqual(fieldsOf('GraphQLShopOwnerAddress'))
		expect(typeOfField('GraphQLCompanyAddress', 'position')).toEqual({
			kind: 'NON_NULL',
			name: null,
			ofType: { kind: 'OBJECT', name: 'GraphQLCompanyPosition', ofType: null }
		})
	})

	// The two nullable fields, and the only two. They mirror the collection's `required` array — `taxCode`
	// did not exist before the extraction, so no stored company carries one, and a GraphQLNonNull on
	// either would turn every one of those rows into a query that errors.
	it('leaves taxCode and uniqueCode nullable, and nothing else', () => {
		const nonNull = (types.get('GraphQLCompany')?.fields ?? []).filter((f) => f.type.kind !== 'NON_NULL').map((f) => f.name)

		expect(nonNull).toEqual(['taxCode', 'uniqueCode'])
	})
})

describe('input types', () => {
	// The write shape of a company is the read shape minus the two fields the client does not get to
	// choose: `_id` is minted by the lib, `idShopOwner` is a separate argument on the create and is
	// nowhere at all on the update. Derived from the output type rather than spelled out, so a field
	// added to one and forgotten on the other fails here instead of surfacing as a form that silently
	// drops what the operator typed.
	it('mirrors the company, minus the two fields the operator cannot set', () => {
		expect(inputFieldsOf('GraphQLInputCompany')).toEqual(
			fieldsOf('GraphQLCompany').filter((f) => f !== '_id' && f !== 'idShopOwner')
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
})
