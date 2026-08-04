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

	it('exposes the seven admin queries', () => {
		expect(fieldsOf('QueriesApi')).toEqual([
			'infoAdminAfterLogin',
			'imprenditoriAttiviTbl',
			'imprenditoriStats',
			'imprenditoriPerPeriodo',
			'imprenditoreById',
			'imprenditorePuntiVendita',
			'imprenditoreAziende'
		])
	})

	it('exposes the fifteen mutations', () => {
		expect(fieldsOf('MutationsApi')).toEqual([
			'adminUpdatePwd',
			'imprenditoreAdd',
			'imprenditoreDel',
			'imprenditoreUpdate',
			'imprenditoreUpdateEmail',
			'imprenditoreUpdateNote',
			'imprenditoreUpdatePreferenze',
			'imprenditoreUpdateStato',
			'aziendaAdd',
			'aziendaDel',
			'aziendaUpdate',
			'puntoVenditaAdd',
			'puntoVenditaDel',
			'puntoVenditaUpdate',
			'puntoVenditaUpdateStato'
		])
	})

	it.each([
		['adminUpdatePwd', ['passwordOld', 'passwordNew'], 'aggiorna la password del proprio account admin'],
		['imprenditoreAdd', ['login', 'anagrafica'], 'aggiunge imprenditore'],
		['imprenditoreDel', ['_id'], 'elimina imprenditore'],
		['imprenditoreUpdate', ['_id', 'anagrafica'], 'aggiorna imprenditore'],
		['imprenditoreUpdateEmail', ['_id', 'email'], "aggiorna l'email di login dell'imprenditore"],
		['imprenditoreUpdateNote', ['_id', 'note'], "aggiorna la nota interna sull'imprenditore"],
		[
			'imprenditoreUpdatePreferenze',
			['_id', 'rememberMe', 'onboardingDone', 'onboardingStep'],
			"aggiorna le preferenze di login dell'imprenditore"
		],
		['imprenditoreUpdateStato', ['_id', 'disabled', 'waitApprov'], "aggiorna lo stato dell'account imprenditore"],
		// `idImprenditore` sits beside the input object on the create, and is absent from the update: a
		// company cannot be handed to another owner by saving its card. The schema is where that is
		// enforced — the resolver never sees an argument the type system does not declare.
		['aziendaAdd', ['idImprenditore', 'azienda'], 'aggiunge un’azienda a un imprenditore'],
		['aziendaDel', ['_id'], 'elimina un’azienda'],
		['aziendaUpdate', ['_id', 'azienda'], 'aggiorna un’azienda'],
		// ⚠️ `idAzienda` on both shop writes, `azienda` on both company writes, and the two are not the same
		// thing: the shop argument is the ObjectId the document stores under that exact name since
		// 20260803000100, the company one is the input object carrying the ragione sociale and the rest.
		[
			'puntoVenditaAdd',
			['idImprenditore', 'nome', 'idAzienda', 'indirizzo', 'contatti', 'orari'],
			'aggiunge un punto vendita a un imprenditore'
		],
		['puntoVenditaDel', ['_id'], 'elimina un punto vendita'],
		['puntoVenditaUpdate', ['_id', 'nome', 'idAzienda', 'indirizzo', 'contatti', 'orari'], 'aggiorna un punto vendita'],
		['puntoVenditaUpdateStato', ['_id', 'disabledByAdmin'], 'aggiorna lo stato di un punto vendita']
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
		['imprenditoreAziende', ['idImprenditore'], 'Get aziende imprenditore'],
		['imprenditoreById', ['idImprenditore'], 'Get imprenditori per tabella'],
		['imprenditorePuntiVendita', ['idImprenditore'], 'Get punti vendita imprenditore per tabella'],
		['imprenditoriAttiviTbl', ['offset', 'limit', 'search', 'sortBy', 'sortDir'], 'Get imprenditori per tabella'],
		['imprenditoriPerPeriodo', ['periodo'], 'Serie temporale degli imprenditori iscritti'],
		['imprenditoriStats', [], 'Imprenditori stats'],
		['infoAdminAfterLogin', [], 'Info after login']
	])('%s takes the arguments the resolver reads', (name, expected, description) => {
		const field = types.get('QueriesApi')?.fields?.find((f) => f.name === name)
		expect(field?.args.map((a) => a.name)).toEqual(expected)
		expect(field?.description).toBe(description)
	})
})

describe('imprenditoriAttiviTbl paging contract', () => {
	// The defaults are part of the public contract: a client that sends none of these still gets a
	// bounded page, which is the whole reason the unbounded list query could be removed. Read from
	// the assembled schema rather than from the resolver's source, so the constant the resolver
	// imports for `limit` is checked at the value it actually reaches the client with.
	it('defaults to the newest 25, and to no search', () => {
		const defaults = Object.fromEntries(argsOf('QueriesApi', 'imprenditoriAttiviTbl').map((a) => [a.name, a.defaultValue]))

		expect(defaults).toEqual({
			offset: '0',
			limit: '25',
			// null, not a string: `search` is the one nullable argument, because "not searching" is a
			// real state of the table and a distinct one from searching for the empty string.
			search: null,
			sortBy: 'ISCRIZIONE',
			sortDir: 'DESC'
		})
	})

	// `sortBy` becomes a key of the Mongo sort document. Enumerating it is what stops a caller from
	// ordering by an arbitrary field — every value below has a matching index in marketplace-db-setup,
	// and a free String here would let anyone turn the query into a blocking in-memory sort.
	it('offers exactly the four sortable columns and two directions', () => {
		expect(enumValuesOf('GraphQLImprenditoriTblSortField')).toEqual(['ISCRIZIONE', 'NOME', 'COGNOME', 'COMUNE'])
		expect(enumValuesOf('GraphQLSortDirection')).toEqual(['ASC', 'DESC'])
	})

	it('returns a page, not a list', () => {
		expect(fieldsOf('GraphQLImprenditoriAttiviTblPage')).toEqual(['items', 'total'])
	})
})

describe('imprenditoriPerPeriodo contract', () => {
	// `TUTTO` is the default because it is the only range that answers "how did we get here" without
	// the caller already knowing the shape of the data. Read from the assembled schema, so what is
	// checked is the value a client that sends no argument actually gets.
	it('defaults to the whole history', () => {
		const defaults = Object.fromEntries(argsOf('QueriesApi', 'imprenditoriPerPeriodo').map((a) => [a.name, a.defaultValue]))

		expect(defaults).toEqual({ periodo: 'TUTTO' })
	})

	// Enumerated for the same reason `sortBy` is: the value picks a range start AND a bucket width,
	// so a free Int here would let a caller ask for a hundred years of day buckets — one `$group` per
	// day, gap-filled into an array the browser then has to draw.
	it('offers exactly the three ranges', () => {
		expect(enumValuesOf('GraphQLPeriodoImprenditori')).toEqual(['TUTTO', 'TRE_MESI', 'UN_MESE'])
	})

	// Reported, never requested — there is no `granularita` argument anywhere. The bucket width is a
	// consequence of the range, and this is the assertion that keeps it one.
	it('reports the granularity it chose, and takes no say in it', () => {
		expect(fieldsOf('GraphQLImprenditoriPerPeriodo')).toEqual(['granularita', 'punti'])
		expect(enumValuesOf('GraphQLGranularitaPeriodo')).toEqual(['GIORNO', 'MESE'])
		expect(argsOf('QueriesApi', 'imprenditoriPerPeriodo').map((a) => a.name)).not.toContain('granularita')
	})

	it('carries a bucket key and a count per point', () => {
		expect(fieldsOf('GraphQLImprenditoriPerPeriodoPunto')).toEqual(['data', 'totale'])
	})
})

describe('object types', () => {
	it('GraphQLAdminInfoAfterLogin carries the session identity', () => {
		expect(fieldsOf('GraphQLAdminInfoAfterLogin')).toEqual(['_id', 'email'])
	})

	it('GraphQLImprenditoreById mirrors the projection of its query', () => {
		expect(fieldsOf('GraphQLImprenditoreById')).toEqual([
			'_id',
			'login',
			'anagrafica',
			'iscrizione',
			'deleted',
			'disabled',
			'waitApprov',
			'note',
			'resetPwd'
		])
		expect(fieldsOf('GraphQLImprenditoreLogin')).toEqual([
			'email',
			'firstLogin',
			'lastLogin',
			'onboardingStep',
			'onboardingDone',
			'rememberMe'
		])
		expect(fieldsOf('GraphQLAnagraficaImprenditoreById')).toEqual(['nome', 'cognome', 'indirizzo', 'nascita', 'contatti'])
		expect(fieldsOf('GraphQLImprenditoreContatti')).toEqual(['email', 'fisso', 'cellulare'])
		expect(fieldsOf('GraphQLResetPwd')).toEqual(['resetDateReq', 'resetHash'])
		expect(fieldsOf('GraphQLDataNascita')).toEqual(['data'])
	})

	it('GraphQLImprenditoreAttiviTbl stays a narrow table projection', () => {
		expect(fieldsOf('GraphQLImprenditoreAttiviTbl')).toEqual(['_id', 'iscrizione', 'anagrafica'])
		expect(fieldsOf('GraphQLAnagrafica')).toEqual(['nome', 'cognome', 'indirizzo'])
	})

	// Both address types spread the same shared fragment from marketplace-common, so the four address
	// fields must stay identical — a drift there means the fragment was edited in one place only. The
	// detail type carries one field more: the table never draws a map, so it does not ask for the point.
	it('spreads the shared address fragment in both address types', () => {
		const tabella = fieldsOf('GraphQLIndirizzoImprenditoreTbl')
		expect(tabella.length).toBeGreaterThan(0)
		expect(fieldsOf('GraphQLIndirizzoImprenditore')).toEqual([...tabella, 'position'])
	})

	// ⚠️ Nullable here, non-null on the shop. Every imprenditore stored before
	// 20260802000300-alter-imprenditore-position-note has an address and no coordinates, and there is
	// nothing to derive them from — a GraphQLNonNull would turn each of those accounts into a query
	// that errors instead of a map that is simply not drawn yet. The wrapper `kind` is what is
	// asserted, not just the name: a name-only check reads the same on both shapes, which is the
	// mistake this pins.
	it('leaves the imprenditore point nullable, unlike the shop one', () => {
		expect(typeOfField('GraphQLIndirizzoImprenditore', 'position')).toEqual({
			kind: 'OBJECT',
			name: 'GraphQLPosizioneImprenditore',
			ofType: null
		})
		expect(typeOfField('GraphQLPVIndirizzo', 'position')).toEqual({
			kind: 'NON_NULL',
			name: null,
			ofType: { kind: 'OBJECT', name: 'GraphQLPVPosition', ofType: null }
		})
	})

	it('carries the same point shape on both, once unwrapped', () => {
		expect(fieldsOf('GraphQLPosizioneImprenditore')).toEqual(fieldsOf('GraphQLPVPosition'))
		expect(fieldsOf('GraphQLPosizioneImprenditore').length).toBeGreaterThan(0)
	})

	it('GraphQLPuntoVendita carries the insegna and nests azienda, indirizzo, contatti and the opening hours', () => {
		// `nome` is the shop's own insegna and sits beside `azienda`, not inside it: the ragione sociale
		// under `azienda` names the company that owns the shop, so a chain's branches share it and none
		// of them is called by it. The card title reads `nome`.
		//
		// `disabled` and `disabledByAdmin` close the list: the two independent disable switches, both
		// nullable Boolean, absent when the shop is open. The read query serves them straight from the
		// stored document (`.lean()`), which is why the type has to declare them or they never ship.
		expect(fieldsOf('GraphQLPuntoVendita')).toEqual([
			'_id',
			'nome',
			'azienda',
			'indirizzo',
			'contatti',
			'inserted',
			'orari',
			'disabled',
			'disabledByAdmin'
		])
		expect(fieldsOf('GraphQLPVContatti')).toEqual(['cellulare', 'email', 'web', 'pec', 'fisso'])
		expect(fieldsOf('GraphQLOrario')).toEqual(['giorno', 'da', 'a'])
		// The punto vendita address adds the geo position on top of the shared fragment.
		expect(fieldsOf('GraphQLPVIndirizzo')).toEqual([...fieldsOf('GraphQLIndirizzoImprenditoreTbl'), 'position'])
		expect(fieldsOf('GraphQLPVPosition').length).toBeGreaterThan(0)
	})

	// ⚠️ An OBJECT, not the ID the document stores. `puntoVendita.idAzienda` has been an ObjectId since
	// 20260803000100 and the field is resolved through `funAziendaById`, so a client reading a shop still
	// gets the whole company inline and never has to make the second round-trip itself — which is also
	// why the output field keeps the bare name while the stored path took the `id` prefix. Asserting the
	// wrapper chain rather than the name is what separates this from the shape it would have if the
	// resolver were dropped and the raw id shipped instead — `GraphQLID!` reads as "non-null azienda" to
	// a name-only check just as convincingly.
	it('resolves the shop’s azienda to the company itself, not to its id', () => {
		expect(typeOfField('GraphQLPuntoVendita', 'azienda')).toEqual({
			kind: 'NON_NULL',
			name: null,
			ofType: { kind: 'OBJECT', name: 'GraphQLAzienda', ofType: null }
		})
	})

	it('GraphQLAzienda carries the company, its owner and its legal seat', () => {
		// `idImprenditore` is second, right after the id: it is the field every read of a company is
		// scoped by, and the operator app reaches one only through its owner's page.
		expect(fieldsOf('GraphQLAzienda')).toEqual([
			'_id',
			'idImprenditore',
			'ragionesociale',
			'piva',
			'cf',
			'referente',
			'amministratore',
			'univoco',
			'pec',
			'indirizzo',
			'visura'
		])
		// Same shared fragments as the shop's address, so the four base fields cannot drift apart, and the
		// position is non-null on both — unlike the imprenditore's, every company seat is geocoded at
		// creation because the collection has no rows predating the requirement.
		expect(fieldsOf('GraphQLAziendaIndirizzo')).toEqual(fieldsOf('GraphQLPVIndirizzo'))
		expect(fieldsOf('GraphQLAziendaPosition')).toEqual(fieldsOf('GraphQLPVPosition'))
		expect(typeOfField('GraphQLAziendaIndirizzo', 'position')).toEqual({
			kind: 'NON_NULL',
			name: null,
			ofType: { kind: 'OBJECT', name: 'GraphQLAziendaPosition', ofType: null }
		})
	})

	// The two nullable fields, and the only two. They mirror the collection's `required` array — `cf`
	// did not exist before the extraction, so no stored company carries one, and a GraphQLNonNull on
	// either would turn every one of those rows into a query that errors.
	it('leaves cf and univoco nullable, and nothing else', () => {
		const nonNull = (types.get('GraphQLAzienda')?.fields ?? []).filter((f) => f.type.kind !== 'NON_NULL').map((f) => f.name)

		expect(nonNull).toEqual(['cf', 'univoco'])
	})
})

describe('input types', () => {
	// The write side of the punto vendita, and the one place the read and write shapes are compared.
	// They are not identical and must not be assumed to be: `inserted` is stamped once and never
	// edited, so it is on the output type and absent here.
	it('mirrors the editable sub-documents of a punto vendita', () => {
		expect(inputFieldsOf('GraphQLInputPuntoVenditaContatti')).toEqual(fieldsOf('GraphQLPVContatti'))
		expect(inputFieldsOf('GraphQLInputPuntoVenditaOrari')).toEqual(fieldsOf('GraphQLOrario'))
		expect(inputFieldsOf('GraphQLInputPuntoVenditaIndirizzo')).toEqual(fieldsOf('GraphQLPVIndirizzo'))
	})

	// The write shape of a company is the read shape minus the two fields the client does not get to
	// choose: `_id` is minted by the lib, `idImprenditore` is a separate argument on the create and is
	// nowhere at all on the update. Derived from the output type rather than spelled out, so a field
	// added to one and forgotten on the other fails here instead of surfacing as a form that silently
	// drops what the operator typed.
	it('mirrors the company, minus the two fields the operator cannot set', () => {
		expect(inputFieldsOf('GraphQLInputAzienda')).toEqual(
			fieldsOf('GraphQLAzienda').filter((f) => f !== '_id' && f !== 'idImprenditore')
		)
		expect(inputFieldsOf('GraphQLInputAziendaIndirizzo')).toEqual(fieldsOf('GraphQLAziendaIndirizzo'))
	})

	// Asserted as an absence, like adminUpdatePwd's missing `_id` above. A GeoJSON `type` has exactly
	// one legal value here — the collection caps the field at 5 characters and the model declares it as
	// an enum of `['Point']` — so an input field for it could only ever carry the right answer or a
	// document that fails validation naming a field the operator never saw. The resolver writes the
	// literal instead; putting `type` back would silently hand that decision to the client.
	it('gives the position inputs no way to name a geometry other than Point', () => {
		expect(inputFieldsOf('GraphQLInputPuntoVenditaPosition')).toEqual(['coordinates'])
		expect(inputFieldsOf('GraphQLInputAziendaPosition')).toEqual(['coordinates'])
	})
})
