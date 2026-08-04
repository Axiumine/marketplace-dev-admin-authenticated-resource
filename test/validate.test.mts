import { describe, expect, it } from 'vitest'

import { failure, motivo } from './errors.mts'

const {
	coordinate,
	dataNascita,
	emailObbligatoria,
	ETA_MINIMA,
	FORMA_CAP,
	FORMA_EMAIL,
	FORMA_PIVA,
	FORMA_PROVINCIA,
	FORMA_UNIVOCO,
	MAX_EMAIL,
	testoConFormato,
	testoObbligatorio,
	testoOpzionale,
	testoOpzionaleConFormato,
	testoOpzionaleLunghezzaEsatta
} = await import('../src/lib/validate/campi.mts')

const { validaAnagraficaImprenditore } = await import('../src/lib/validate/validaAnagraficaImprenditore.mts')

const { validaNotaImprenditore } = await import('../src/lib/validate/validaNotaImprenditore.mts')

const { validaAzienda } = await import('../src/lib/validate/validaAzienda.mts')

const { validaIndirizzo } = await import('../src/lib/validate/validaIndirizzo.mts')

/** An address of exactly `MAX_EMAIL` characters: 244 of local part, plus the six of `@ex.it`. */
const emailAlLimite = `${'a'.repeat(MAX_EMAIL - 6)}@ex.it`

describe('testoObbligatorio', () => {
	it('trims before measuring, so trailing spaces are neither content nor overflow', () => {
		expect(testoObbligatorio('  Mario  ', 'nome', 5)).toBe('Mario')
	})

	it.each([
		['an empty string', '', 'nome: campo obbligatorio'],
		['a box holding only spaces', '     ', 'nome: campo obbligatorio'],
		['one character over the cap', 'abcdef', 'nome: massimo 5 caratteri'],
		['a long value whose trailing spaces do not save it', '  abcdef  ', 'nome: massimo 5 caratteri']
	])('refuses %s', (_desc, valore, atteso) => {
		expect(motivo(() => testoObbligatorio(valore, 'nome', 5))).toBe(atteso)
	})

	// The cap is inclusive: `maxLength: 5` in the collection accepts five characters, so the validator
	// that guards it has to accept them too, or it rejects values the database would have taken.
	it('accepts a value of exactly the maximum length', () => {
		expect(testoObbligatorio('abcde', 'nome', 5)).toBe('abcde')
	})
})

describe('testoOpzionaleLunghezzaEsatta', () => {
	it('trims and returns a value of exactly the required length', () => {
		expect(testoOpzionaleLunghezzaEsatta('  12345678901  ', 'azienda.cf', 11)).toBe('12345678901')
	})

	// Same absence rule as every other optional field: a cleared box has to be *absent* from the `$set`,
	// not present as an empty string that fails the collection's `minLength: 11`.
	it.each([[null], [undefined], [''], ['    ']])('reads %p as not given', (valore) => {
		expect(testoOpzionaleLunghezzaEsatta(valore, 'azienda.cf', 11)).toBeUndefined()
	})

	// One character on either side, because a `!==` written as `<` or `>` passes half the cases.
	it.each([
		['one character short', '1234567890'],
		['one character over', '123456789012']
	])('refuses %s', (_desc, valore) => {
		expect(motivo(() => testoOpzionaleLunghezzaEsatta(valore, 'azienda.cf', 11))).toBe('azienda.cf: esattamente 11 caratteri')
	})

	// No alphabet: the collection constrains `minLength`/`maxLength` and nothing else, and a pattern
	// invented here would reject a value the database takes. A newline counts as a character for the
	// same reason — which is why this is its own helper rather than `testoOpzionaleConFormato` with a
	// `/^.{11}$/`, since `.` does not match one.
	it.each([['ABCDEFGHIJK'], ['12345\n67890']])('accepts %p, since only the length is pinned', (valore) => {
		expect(testoOpzionaleLunghezzaEsatta(valore, 'azienda.cf', 11)).toHaveLength(11)
	})
})

describe('testoOpzionale', () => {
	// All three spellings of "not given" have to collapse to `undefined`, because that is the only one
	// the caller can leave out of the `$set` document — `null` and `''` both reach a `bsonType: 'string'`
	// property and fail the whole write.
	it.each([[null], [undefined], [''], ['    ']])('reads %p as not given', (valore) => {
		expect(testoOpzionale(valore, 'fisso', 12)).toBeUndefined()
	})

	it('trims a value that was given', () => {
		expect(testoOpzionale('  0212345  ', 'fisso', 12)).toBe('0212345')
	})

	it('accepts a value of exactly the maximum length', () => {
		expect(testoOpzionale('123456789012', 'fisso', 12)).toBe('123456789012')
	})

	it('refuses one character over the cap', () => {
		expect(motivo(() => testoOpzionale('1234567890123', 'fisso', 12))).toBe('fisso: massimo 12 caratteri')
	})
})

describe('testoConFormato', () => {
	it('trims and returns a value that matches', () => {
		expect(testoConFormato('  20100  ', 'cap', FORMA_CAP, 'il CAP è di 5 cifre')).toBe('20100')
	})

	// No separate empty test in the source: every pattern is anchored and matches at least one
	// character, so a blank field gets the shape message rather than "campo obbligatorio".
	it('refuses a blank value with the shape message, not an obligatory one', () => {
		expect(motivo(() => testoConFormato('   ', 'cap', FORMA_CAP, 'il CAP è di 5 cifre'))).toBe('cap: il CAP è di 5 cifre')
	})
})

describe('testoOpzionaleConFormato', () => {
	it.each([[null], [undefined], ['   ']])('reads %p as not given, without running the pattern', (valore) => {
		expect(testoOpzionaleConFormato(valore, 'univoco', FORMA_UNIVOCO, 'sette caratteri')).toBeUndefined()
	})

	it('trims and returns a value that matches', () => {
		expect(testoOpzionaleConFormato(' ABC1234 ', 'univoco', FORMA_UNIVOCO, 'sette caratteri')).toBe('ABC1234')
	})

	it('refuses a value that was given and does not match', () => {
		expect(motivo(() => testoOpzionaleConFormato('ABC12', 'univoco', FORMA_UNIVOCO, 'sette caratteri'))).toBe(
			'univoco: sette caratteri'
		)
	})
})

/*
 * The patterns, one table each.
 *
 * Every table carries a value that is right, a value that is the wrong length on each side, a value
 * with the wrong character class, and — the two that are easy to leave out — a value with something
 * glued to the front and one with something glued to the back. Those last two are what an unanchored
 * pattern would let through: `/\d{5}/` without `^` accepts `via 20100`, and without `$` it accepts
 * `20100 Milano`, both of which look like they matched.
 */
describe('the field patterns', () => {
	it.each([
		['20100', true],
		['00100', true],
		['2010', false],
		['201000', false],
		['2010a', false],
		['abcde', false],
		['', false],
		['x20100', false],
		['20100x', false],
		[' 20100', false]
	])('FORMA_CAP accepts %p: %s', (valore, atteso) => {
		expect(FORMA_CAP.test(valore)).toBe(atteso)
	})

	it.each([
		['MI', true],
		['mi', true],
		['Mi', true],
		['M', false],
		['MIL', false],
		['M1', false],
		['12', false],
		['', false],
		['xMI', false],
		['MIx', false],
		['M I', false]
	])('FORMA_PROVINCIA accepts %p: %s', (valore, atteso) => {
		expect(FORMA_PROVINCIA.test(valore)).toBe(atteso)
	})

	it.each([
		['12345678901', true],
		['00000000000', true],
		['1234567890', false],
		['123456789012', false],
		['1234567890a', false],
		['', false],
		['x12345678901', false],
		['12345678901x', false]
	])('FORMA_PIVA accepts %p: %s', (valore, atteso) => {
		expect(FORMA_PIVA.test(valore)).toBe(atteso)
	})

	it.each([
		['ABC1234', true],
		['abc1234', true],
		['0000000', true],
		['ABC123', false],
		['ABC12345', false],
		['ABC-123', false],
		['ABC 123', false],
		['', false],
		['xABC1234', false],
		['ABC1234x', false]
	])('FORMA_UNIVOCO accepts %p: %s', (valore, atteso) => {
		expect(FORMA_UNIVOCO.test(valore)).toBe(atteso)
	})

	// Deliberately loose — one `@`, a dot after it, no whitespace. The rows below are the rubbish it is
	// meant to stop, not an attempt at RFC 5322.
	it.each([
		['mario@marketplace.test', true],
		['m.rossi+tag@sub.marketplace.co.uk', true],
		['a@b.c', true],
		['mario@marketplace', false],
		['mariomarketplace.test', false],
		['@marketplace.test', false],
		['mario@.test', false],
		['mario@marketplace.', false],
		['mario@@marketplace.test', false],
		['ma rio@marketplace.test', false],
		['mario@marketplace.test ', false],
		[' mario@marketplace.test', false],
		['', false]
	])('FORMA_EMAIL accepts %p: %s', (valore, atteso) => {
		expect(FORMA_EMAIL.test(valore)).toBe(atteso)
	})
})

describe('emailObbligatoria', () => {
	it('trims and returns a well-formed address', () => {
		expect(emailObbligatoria('  mario@marketplace.test ', 'contatti.email')).toBe('mario@marketplace.test')
	})

	// The cap is the collection's 250, not koa-utils' platform-wide 255: validating against the wrong
	// one would pass a 253-character address into a driver rejection with no readable message.
	it('accepts an address of exactly 250 characters', () => {
		expect(emailObbligatoria(emailAlLimite, 'contatti.email')).toBe(emailAlLimite)
		expect(MAX_EMAIL).toBe(250)
	})

	it.each([
		['a blank box', '   ', 'contatti.email: campo obbligatorio'],
		['one character over the cap', `x${emailAlLimite}`, 'contatti.email: massimo 250 caratteri'],
		['a malformed address', 'mario@marketplace', 'contatti.email: indirizzo email non valido']
	])('refuses %s', (_desc, valore, atteso) => {
		expect(motivo(() => emailObbligatoria(valore, 'contatti.email'))).toBe(atteso)
	})
})

describe('dataNascita', () => {
	const oggi = new Date('2026-08-02T00:00:00.000Z')

	it('accepts a date comfortably in the past', () => {
		const data = new Date('1990-05-17T00:00:00.000Z')

		expect(dataNascita(data, 'nascita.data', oggi)).toBe(data)
	})

	// Inclusive on purpose: someone turning 18 today is 18 today. This is also the row that dies if the
	// comparison is loosened to `>=`, or if the leap-year correction is applied unconditionally.
	it('accepts someone whose eighteenth birthday is today', () => {
		const data = new Date('2008-08-02T00:00:00.000Z')

		expect(dataNascita(data, 'nascita.data', oggi)).toBe(data)
	})

	it('refuses someone whose eighteenth birthday is tomorrow', () => {
		expect(motivo(() => dataNascita(new Date('2008-08-03T00:00:00.000Z'), 'nascita.data', oggi))).toBe(
			"nascita.data: l'imprenditore deve essere maggiorenne (almeno 18 anni)"
		)
		expect(ETA_MINIMA).toBe(18)
	})

	it('refuses a date that is not a date', () => {
		expect(motivo(() => dataNascita(new Date('non una data'), 'nascita.data', oggi))).toBe('nascita.data: data non valida')
	})

	/*
	 * The one case `Date.UTC` gets wrong on its own. 29 February minus 18 years is 29 February 2006,
	 * which does not exist, and `Date.UTC` rolls it forward to 1 March — a limit one day *later* than
	 * intended, which admits someone whose birthday has not happened yet. `setUTCDate(0)` steps back to
	 * 28 February instead.
	 */
	describe('on 29 February', () => {
		const bisestile = new Date('2024-02-29T00:00:00.000Z')

		it('puts the limit on 28 February, not 1 March', () => {
			const data = new Date('2006-02-28T00:00:00.000Z')

			expect(dataNascita(data, 'nascita.data', bisestile)).toBe(data)
		})

		it('refuses the day the rollover would have let through', () => {
			expect(motivo(() => dataNascita(new Date('2006-03-01T00:00:00.000Z'), 'nascita.data', bisestile))).toBe(
				"nascita.data: l'imprenditore deve essere maggiorenne (almeno 18 anni)"
			)
		})
	})
})

describe('coordinate', () => {
	it('returns the pair, longitude first', () => {
		expect(coordinate([9.19, 45.46], 'pos')).toEqual([9.19, 45.46])
	})

	it.each([[[]], [[9.19]], [[9.19, 45.46, 120]]])('refuses %p, which is not a pair', (coordinates) => {
		expect(motivo(() => coordinate(coordinates, 'pos'))).toBe('pos: servono esattamente 2 coordinate [longitudine, latitudine]')
	})

	// The two axes have different bounds — that asymmetry is what
	// 20260801000000-alter-puntoVendita-position fixed in the collection, and a single ±180 rule here
	// would put a latitude of 120 into a 2dsphere index that cannot key it.
	it.each([[[-180, 0]], [[180, 0]], [[0, -90]], [[0, 90]]])('accepts %p, exactly on the boundary', (coordinates) => {
		expect(coordinate(coordinates, 'pos')).toEqual(coordinates)
	})

	it.each([[[-180.1, 0]], [[180.1, 0]], [[Number.NaN, 0]], [[Number.POSITIVE_INFINITY, 0]]])(
		'refuses %p for its longitude',
		(coordinates) => {
			expect(motivo(() => coordinate(coordinates, 'pos'))).toBe('pos: longitudine fuori da -180..180')
		}
	)

	it.each([[[0, -90.1]], [[0, 90.1]], [[0, Number.NaN]], [[0, Number.NEGATIVE_INFINITY]]])(
		'refuses %p for its latitude',
		(coordinates) => {
			expect(motivo(() => coordinate(coordinates, 'pos'))).toBe('pos: latitudine fuori da -90..90')
		}
	)
})

describe('validaAnagraficaImprenditore', () => {
	const oggi = new Date('2026-08-02T00:00:00.000Z')
	const nascita = { data: new Date('1990-05-17T00:00:00.000Z') }

	const valida = {
		nome: '  Mario  ',
		cognome: ' Rossi ',
		nascita,
		indirizzo: { indirizzo: ' Via Roma 1 ', cap: ' 20100 ', comune: ' Milano ', provincia: 'mi' },
		contatti: { cellulare: ' 3331234567 ', fisso: ' 0212345 ', email: ' mario@marketplace.test ' }
	} as never

	it('returns a trimmed copy with the provincia upper-cased', () => {
		expect(validaAnagraficaImprenditore(valida, oggi)).toEqual({
			nome: 'Mario',
			cognome: 'Rossi',
			nascita: { data: nascita.data },
			indirizzo: { indirizzo: 'Via Roma 1', cap: '20100', comune: 'Milano', provincia: 'MI' },
			contatti: { cellulare: '3331234567', fisso: '0212345', email: 'mario@marketplace.test' }
		})
	})

	// `$set: { anagrafica }` replaces the whole sub-document, so a cleared landline has to be *absent*
	// from the returned object. Present holding `undefined` is serialised to `null` by the BSON writer
	// and fails the collection validator, taking the rest of the save with it.
	it('drops a cleared landline instead of writing it empty', () => {
		const senzaFisso = validaAnagraficaImprenditore(
			{ ...(valida as object), contatti: { cellulare: '3331234567', fisso: '   ', email: 'mario@marketplace.test' } } as never,
			oggi
		)

		expect(Object.keys(senzaFisso.contatti)).toEqual(['cellulare', 'email'])
		expect('fisso' in senzaFisso.contatti).toBe(false)
	})

	// One row per field, so a validator wired to the wrong argument — the copy-paste failure this shape
	// of code invites — shows up as the wrong field name in the message rather than as a passing test.
	it.each([
		['nome', { nome: '' }, 'nome: campo obbligatorio'],
		['cognome', { cognome: '  ' }, 'cognome: campo obbligatorio'],
		['nome over the cap', { nome: 'a'.repeat(101) }, 'nome: massimo 100 caratteri'],
		['cognome over the cap', { cognome: 'a'.repeat(101) }, 'cognome: massimo 100 caratteri'],
		[
			'nascita.data',
			{ nascita: { data: new Date('2020-01-01T00:00:00.000Z') } },
			"nascita.data: l'imprenditore deve essere maggiorenne (almeno 18 anni)"
		]
	])('refuses a bad %s', (_desc, patch, atteso) => {
		expect(motivo(() => validaAnagraficaImprenditore({ ...(valida as object), ...patch } as never, oggi))).toBe(atteso)
	})

	it.each([
		['indirizzo.indirizzo', { indirizzo: '' }, 'indirizzo.indirizzo: campo obbligatorio'],
		['indirizzo.indirizzo over the cap', { indirizzo: 'a'.repeat(251) }, 'indirizzo.indirizzo: massimo 250 caratteri'],
		['indirizzo.cap', { cap: '2010' }, 'indirizzo.cap: il CAP è di 5 cifre'],
		['indirizzo.comune', { comune: '   ' }, 'indirizzo.comune: campo obbligatorio'],
		['indirizzo.provincia', { provincia: 'MIL' }, 'indirizzo.provincia: la provincia è la sigla di 2 lettere']
	])('refuses a bad %s', (_desc, patch, atteso) => {
		const anagrafica = {
			...(valida as object),
			indirizzo: { ...(valida as never as { indirizzo: object }).indirizzo, ...patch }
		} as never

		expect(motivo(() => validaAnagraficaImprenditore(anagrafica, oggi))).toBe(atteso)
	})

	it.each([
		['contatti.cellulare', { cellulare: '' }, 'contatti.cellulare: campo obbligatorio'],
		['contatti.cellulare over the cap', { cellulare: '1234567890123' }, 'contatti.cellulare: massimo 12 caratteri'],
		['contatti.fisso over the cap', { fisso: '1234567890123' }, 'contatti.fisso: massimo 12 caratteri'],
		['contatti.email', { email: 'mario@marketplace' }, 'contatti.email: indirizzo email non valido']
	])('refuses a bad %s', (_desc, patch, atteso) => {
		const anagrafica = {
			...(valida as object),
			contatti: { ...(valida as never as { contatti: object }).contatti, ...patch }
		} as never

		expect(motivo(() => validaAnagraficaImprenditore(anagrafica, oggi))).toBe(atteso)
	})

	// The input type carries the coordinates alone; the `type: 'Point'` the collection validator requires
	// is added here, so the client never sends a constant it could get wrong.
	it('wraps the coordinates in a GeoJSON point', () => {
		const conPosizione = validaAnagraficaImprenditore(
			{
				...(valida as object),
				indirizzo: {
					...(valida as never as { indirizzo: object }).indirizzo,
					position: { coordinates: [9.19, 45.46] }
				}
			} as never,
			oggi
		)

		expect(conPosizione.indirizzo.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	})

	// `position` is optional in the collection and nothing backfills it, so every imprenditore created
	// before 20260802000300 still has none. Absent has to stay absent: `$set: { anagrafica }` replaces the
	// whole sub-document, and a key present holding `undefined` is written as `null`, which the validator
	// rejects — taking the rest of the save with it, exactly as a cleared landline would.
	it.each([
		['assente', {}],
		['null', { position: null }],
		['undefined', { position: undefined }]
	])('omits the point entirely when it is %s', (_desc, patch) => {
		const senzaPosizione = validaAnagraficaImprenditore(
			{
				...(valida as object),
				indirizzo: { ...(valida as never as { indirizzo: object }).indirizzo, ...patch }
			} as never,
			oggi
		)

		expect('position' in senzaPosizione.indirizzo).toBe(false)
	})

	// The bounds themselves are `coordinate`'s, tested above; what this pins is the path prefix, which is
	// the only part of the message this function contributes.
	it.each([
		[[9.19], 'indirizzo.position.coordinates: servono esattamente 2 coordinate [longitudine, latitudine]'],
		[[9.19, 120], 'indirizzo.position.coordinates: latitudine fuori da -90..90'],
		[[190, 45.46], 'indirizzo.position.coordinates: longitudine fuori da -180..180']
	])('refuses %p, naming the nested path', (coordinates, atteso) => {
		const anagrafica = {
			...(valida as object),
			indirizzo: { ...(valida as never as { indirizzo: object }).indirizzo, position: { coordinates } }
		} as never

		expect(motivo(() => validaAnagraficaImprenditore(anagrafica, oggi))).toBe(atteso)
	})
})

describe('validaNotaImprenditore', () => {
	it('returns the note trimmed', () => {
		expect(validaNotaImprenditore('  Richiamare a settembre  ')).toBe('Richiamare a settembre')
	})

	// `''`, not `undefined`: the caller writes it straight into `funImprenditoreUpdateNote`, which reads
	// the empty string as "remove the field". `testoOpzionale` alone would hand back `undefined` and the
	// `$unset` branch would never be taken.
	it.each([[''], ['   '], ['\n\t']])('turns %p into the empty string that clears the note', (note) => {
		expect(validaNotaImprenditore(note)).toBe('')
	})

	it('accepts a note of exactly 2000 characters', () => {
		expect(validaNotaImprenditore('a'.repeat(2000))).toHaveLength(2000)
	})

	// The collection caps `note` at 2000; over it the driver would answer with an opaque validation
	// failure, so the bound is restated here to name the field.
	it('refuses a note over the cap', () => {
		expect(motivo(() => validaNotaImprenditore('a'.repeat(2001)))).toBe('note: massimo 2000 caratteri')
	})

	it('raises a 400 rather than a generic failure', () => {
		expect(failure(() => validaNotaImprenditore('a'.repeat(2001)))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'note: massimo 2000 caratteri'
		})
	})
})

describe('validaIndirizzo', () => {
	const valido = {
		indirizzo: ' Via Milano 9 ',
		cap: ' 20100 ',
		comune: ' Milano ',
		provincia: 'mi',
		position: { coordinates: [9.19, 45.46] }
	}

	// `type` is written, never read off the argument: there is one legal value, so accepting it from the
	// client would only create a way to get it wrong.
	it('stamps the GeoJSON type itself and upper-cases the provincia', () => {
		expect(validaIndirizzo(valido, 'indirizzo')).toEqual({
			indirizzo: 'Via Milano 9',
			cap: '20100',
			comune: 'Milano',
			provincia: 'MI',
			position: { type: 'Point', coordinates: [9.19, 45.46] }
		})
	})

	// ⚠️ The prefix is the whole reason this takes a second argument: one validator serves two collections
	// since 20260803000000 restated `puntoVendita.indirizzo` on `azienda` field for field, and the operator
	// has to be told which of the two addresses on the page is wrong.
	it('names the path it was given, so the same failure reads differently for a shop and for a company', () => {
		expect(motivo(() => validaIndirizzo({ ...valido, cap: 'ABCDE' }, 'indirizzo'))).toBe('indirizzo.cap: il CAP è di 5 cifre')
		expect(motivo(() => validaIndirizzo({ ...valido, cap: 'ABCDE' }, 'azienda.indirizzo'))).toBe(
			'azienda.indirizzo.cap: il CAP è di 5 cifre'
		)
	})

	// ⚠️ 100 here, 250 on an imprenditore. Same field name, same GraphQL fragment, different collections.
	it('caps the street address at 100, not at the imprenditore’s 250', () => {
		expect(validaIndirizzo({ ...valido, indirizzo: 'a'.repeat(100) }, 'indirizzo').indirizzo).toHaveLength(100)
		expect(motivo(() => validaIndirizzo({ ...valido, indirizzo: 'a'.repeat(101) }, 'indirizzo'))).toBe(
			'indirizzo.indirizzo: massimo 100 caratteri'
		)
	})

	it.each([
		['indirizzo', { indirizzo: '  ' }, 'indirizzo.indirizzo: campo obbligatorio'],
		['cap', { cap: 'ABCDE' }, 'indirizzo.cap: il CAP è di 5 cifre'],
		['comune', { comune: '' }, 'indirizzo.comune: campo obbligatorio'],
		['comune over the cap', { comune: 'a'.repeat(101) }, 'indirizzo.comune: massimo 100 caratteri'],
		['provincia', { provincia: '1' }, 'indirizzo.provincia: la provincia è la sigla di 2 lettere'],
		[
			'position',
			{ position: { coordinates: [9.19] } },
			'indirizzo.position.coordinates: servono esattamente 2 coordinate [longitudine, latitudine]'
		],
		['latitude', { position: { coordinates: [9.19, 120] } }, 'indirizzo.position.coordinates: latitudine fuori da -90..90']
	])('refuses a bad %s', (_desc, patch, atteso) => {
		expect(motivo(() => validaIndirizzo({ ...valido, ...patch }, 'indirizzo'))).toBe(atteso)
	})
})

describe('validaAzienda', () => {
	const indirizzo = {
		indirizzo: ' Via Milano 9 ',
		cap: ' 20100 ',
		comune: ' Milano ',
		provincia: 'mi',
		position: { coordinates: [9.19, 45.46] }
	}

	const valida = {
		ragionesociale: ' Pizzeria da Mario ',
		piva: ' 12345678901 ',
		cf: ' 12345678901 ',
		referente: ' Mario Rossi ',
		amministratore: ' Mario Rossi ',
		univoco: ' ABC1234 ',
		pec: ' pizzeria@pec.test ',
		indirizzo,
		visura: ' visura-2026 '
	} as never

	it('returns a trimmed copy, with the seat normalised like any other address', () => {
		expect(validaAzienda(valida)).toEqual({
			ragionesociale: 'Pizzeria da Mario',
			piva: '12345678901',
			cf: '12345678901',
			referente: 'Mario Rossi',
			amministratore: 'Mario Rossi',
			univoco: 'ABC1234',
			pec: 'pizzeria@pec.test',
			indirizzo: {
				indirizzo: 'Via Milano 9',
				cap: '20100',
				comune: 'Milano',
				provincia: 'MI',
				position: { type: 'Point', coordinates: [9.19, 45.46] }
			},
			visura: 'visura-2026'
		})
	})

	// The two optional fields, and the same absence rule as a landline: a key present holding `undefined`
	// is written as `null` by the BSON writer and fails the collection validator, taking the save with it.
	it.each([
		['cf', { cf: '  ' }],
		['univoco', { univoco: '   ' }],
		['both', { cf: '', univoco: null }]
	])('drops a blank %s instead of writing it empty', (_desc, patch) => {
		const risultato = validaAzienda({ ...(valida as object), ...patch } as never)

		expect(Object.keys(risultato)).toEqual(
			['ragionesociale', 'piva', 'cf', 'referente', 'amministratore', 'univoco', 'pec', 'indirizzo', 'visura'].filter(
				(k) => !(k in patch)
			)
		)
	})

	// ⚠️ 1000, and it is the collection's cap rather than an invented one — the field was the single
	// unbounded string on the embedded shape until 20260803000000 put a `maxLength` on it.
	it('accepts a visura of exactly 1000 characters and refuses 1001', () => {
		expect(validaAzienda({ ...(valida as object), visura: 'x'.repeat(1000) } as never).visura).toHaveLength(1000)
		expect(motivo(() => validaAzienda({ ...(valida as object), visura: 'x'.repeat(1001) } as never))).toBe(
			'azienda.visura: massimo 1000 caratteri'
		)
	})

	it.each([
		['ragionesociale', { ragionesociale: '' }, 'azienda.ragionesociale: campo obbligatorio'],
		['ragionesociale over the cap', { ragionesociale: 'a'.repeat(101) }, 'azienda.ragionesociale: massimo 100 caratteri'],
		['piva', { piva: '1234567890' }, 'azienda.piva: la partita IVA è di 11 cifre'],
		['cf', { cf: '1234567890' }, 'azienda.cf: esattamente 11 caratteri'],
		['referente', { referente: '   ' }, 'azienda.referente: campo obbligatorio'],
		['referente over the cap', { referente: 'a'.repeat(51) }, 'azienda.referente: massimo 50 caratteri'],
		['amministratore', { amministratore: '' }, 'azienda.amministratore: campo obbligatorio'],
		['amministratore over the cap', { amministratore: 'a'.repeat(51) }, 'azienda.amministratore: massimo 50 caratteri'],
		['univoco', { univoco: 'ABC12' }, 'azienda.univoco: il codice univoco è di 7 caratteri alfanumerici'],
		['pec', { pec: 'pizzeria@pec' }, 'azienda.pec: indirizzo email non valido'],
		['visura', { visura: '   ' }, 'azienda.visura: campo obbligatorio']
	])('refuses a bad %s', (_desc, patch, atteso) => {
		expect(motivo(() => validaAzienda({ ...(valida as object), ...patch } as never))).toBe(atteso)
	})

	// The seat's own failures come through with the company's prefix, which is what keeps them apart from
	// the shop address sitting in the same form.
	it.each([
		['indirizzo', { indirizzo: '  ' }, 'azienda.indirizzo.indirizzo: campo obbligatorio'],
		['cap', { cap: 'ABCDE' }, 'azienda.indirizzo.cap: il CAP è di 5 cifre'],
		[
			'position',
			{ position: { coordinates: [9.19] } },
			'azienda.indirizzo.position.coordinates: servono esattamente 2 coordinate [longitudine, latitudine]'
		]
	])('refuses a bad seat %s, naming the nested path', (_desc, patch, atteso) => {
		expect(motivo(() => validaAzienda({ ...(valida as object), indirizzo: { ...indirizzo, ...patch } } as never))).toBe(atteso)
	})
})
