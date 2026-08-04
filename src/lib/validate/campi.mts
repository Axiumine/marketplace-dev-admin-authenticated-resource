import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'

/**
 * The field-level checks the update mutations run before touching MongoDB.
 *
 * They exist because the collection's `$jsonSchema` is the only thing that was enforcing any of this,
 * and a validator rejection surfaces as a raw driver error: `Document failed validation`, with the
 * offending path buried in `errInfo`. Apollo turns that into a 500 with no usable message, so an
 * operator who typed a four-digit CAP was told the server had broken. Every helper below raises a 400
 * naming the field instead.
 *
 * They also **normalise**, and that half is not cosmetic. `additionalProperties: false` plus
 * `bsonType: 'string'` means an optional contact sent as `null` — which is exactly what a cleared text
 * box serialises to over GraphQL — fails the write. `testoOpzionale` answers `undefined` for anything
 * blank, so the key is simply absent from the `$set` document.
 *
 * The bounds are copied from the migrations, not from koa-utils. They are not the same numbers: the
 * platform's `EMAIL_MAX_LEN` is 255 while every email-shaped path in these two collections is capped at
 * 250, so validating against koa-utils would pass a 253-character address straight into a rejection.
 */

/** Every email-shaped path in `imprenditore` and `azienda`. NOT koa-utils' 255 — see above. */
export const MAX_EMAIL = 250

/**
 * Deliberately loose: one `@`, a dot in the domain, no whitespace.
 *
 * A stricter address grammar belongs nowhere near a validator whose only job is to keep obvious
 * rubbish out of the database — RFC 5322 admits addresses this would be wrong to reject, and the real
 * proof an address exists is a delivered email, which the platform already does elsewhere.
 */
export const FORMA_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const FORMA_CAP = /^\d{5}$/
export const FORMA_PROVINCIA = /^[A-Za-z]{2}$/
export const FORMA_PIVA = /^\d{11}$/
export const FORMA_UNIVOCO = /^[A-Za-z0-9]{7}$/

/** Italian age of majority. An imprenditore signs contracts, so the platform has no under-18 accounts. */
export const ETA_MINIMA = 18

/**
 * A required text field: trimmed, non-empty, within the collection's `maxLength`.
 *
 * Trimmed *before* the length test, so 250 characters of address plus a trailing space is an address
 * and not an overflow, and a box holding four spaces is empty rather than four characters long.
 */
export const testoObbligatorio = (valore: string, campo: string, max: number): string => {
	const pulito = valore.trim()

	if (pulito.length === 0) throwErrorWrongUserInput(`${campo}: campo obbligatorio`)
	if (pulito.length > max) throwErrorWrongUserInput(`${campo}: massimo ${max} caratteri`)

	return pulito
}

/**
 * An optional text field.
 *
 * Blank comes back `undefined` — never `''` and never `null`. Both of those reach the collection as a
 * value of the wrong type for a `bsonType: 'string'` property and fail the whole write, which is how a
 * cleared landline number takes an otherwise valid save down with it.
 */
export const testoOpzionale = (valore: string | null | undefined, campo: string, max: number): string | undefined => {
	const pulito = (valore ?? '').trim()

	if (pulito.length === 0) return undefined
	if (pulito.length > max) throwErrorWrongUserInput(`${campo}: massimo ${max} caratteri`)

	return pulito
}

/**
 * A required text field that also has to match a shape.
 *
 * No separate empty test: every `FORMA_*` above is anchored and matches at least one character, so the
 * empty string fails the pattern and gets the same 400 with a message that says what was expected.
 */
export const testoConFormato = (valore: string, campo: string, forma: RegExp, atteso: string): string => {
	const pulito = valore.trim()

	if (!forma.test(pulito)) throwErrorWrongUserInput(`${campo}: ${atteso}`)

	return pulito
}

/**
 * An optional text field the collection pins to one exact length — `azienda.cf` is the only one.
 *
 * Its own helper rather than `testoOpzionaleConFormato` with a `/^.{11}$/`: `.` does not match a
 * newline, so a pattern would reject an eleven-character value the collection accepts. Length is also
 * all that was asked for — the codice fiscale of a company is the 11-digit form, but the collection
 * constrains `minLength`/`maxLength` and no alphabet, and inventing one here would reject a value the
 * database takes.
 *
 * Blank comes back `undefined`, like every other optional field: a cleared box has to be absent from
 * the `$set`, not present as an empty string that fails `minLength: 11`.
 */
export const testoOpzionaleLunghezzaEsatta = (
	valore: string | null | undefined,
	campo: string,
	lunghezza: number
): string | undefined => {
	const pulito = (valore ?? '').trim()

	if (pulito.length === 0) return undefined
	if (pulito.length !== lunghezza) throwErrorWrongUserInput(`${campo}: esattamente ${lunghezza} caratteri`)

	return pulito
}

/** As above, for a field that may be left blank — `azienda.univoco` is the only one. */
export const testoOpzionaleConFormato = (
	valore: string | null | undefined,
	campo: string,
	forma: RegExp,
	atteso: string
): string | undefined => {
	const pulito = (valore ?? '').trim()

	if (pulito.length === 0) return undefined
	if (!forma.test(pulito)) throwErrorWrongUserInput(`${campo}: ${atteso}`)

	return pulito
}

export const emailObbligatoria = (valore: string, campo: string): string =>
	testoConFormato(testoObbligatorio(valore, campo, MAX_EMAIL), campo, FORMA_EMAIL, 'indirizzo email non valido')

/**
 * The latest birth date that is already `ETA_MINIMA` years old on `oggi`.
 *
 * UTC throughout. `nascita.data` arrives from graphql-scalars' `Date`, which parses `YYYY-MM-DD` to
 * midnight UTC, so reading the calendar parts locally would move the boundary by the server's offset
 * and put the birthday on the wrong side of it for half the world.
 *
 * `Date.UTC` rolls an impossible day forward — 29 February minus 18 years lands in a non-leap year and
 * becomes 1 March, which would accept someone whose eighteenth birthday is tomorrow. `setUTCDate(0)`
 * steps back to the last day of the intended month instead.
 */
const limiteNascita = (oggi: Date): Date => {
	const mese = oggi.getUTCMonth()
	const limite = new Date(Date.UTC(oggi.getUTCFullYear() - ETA_MINIMA, mese, oggi.getUTCDate()))

	if (limite.getUTCMonth() !== mese) limite.setUTCDate(0)

	return limite
}

/**
 * A birth date that is a real date and belongs to someone of age.
 *
 * `oggi` is a parameter rather than a `new Date()` inside, so the boundary can be tested on both sides
 * without freezing the clock. The boundary is inclusive: someone turning 18 today is 18 today.
 */
export const dataNascita = (data: Date, campo: string, oggi: Date): Date => {
	if (Number.isNaN(data.getTime())) throwErrorWrongUserInput(`${campo}: data non valida`)

	if (data.getTime() > limiteNascita(oggi).getTime()) {
		throwErrorWrongUserInput(`${campo}: l'imprenditore deve essere maggiorenne (almeno ${ETA_MINIMA} anni)`)
	}

	return data
}

/**
 * A GeoJSON coordinate pair, `[longitudine, latitudine]` — longitude first.
 *
 * The two axes get different bounds, matching what `20260801000000-alter-puntoVendita-position` put in
 * the collection validator: ±180 for longitude, ±90 for latitude. A single ±180 rule for both is the
 * bug that migration fixed, and re-introducing it here would let a latitude of 120 through to a
 * `2dsphere` index that cannot key it.
 *
 * `Number.isFinite` looks redundant because `GraphQLFloat` refuses NaN and Infinity at the schema
 * boundary, and through the API it is. It stays because without it the two range tests answer `false`
 * for NaN and wave it through — this helper is exported and unit-tested on its own, and one that is
 * only correct when called from one place is worth less than the comparison costs.
 */
export const coordinate = (coordinates: readonly number[], campo: string): number[] => {
	if (coordinates.length !== 2) {
		throwErrorWrongUserInput(`${campo}: servono esattamente 2 coordinate [longitudine, latitudine]`)
	}

	const [lng, lat] = coordinates as [number, number]

	if (!Number.isFinite(lng) || lng < -180 || lng > 180) throwErrorWrongUserInput(`${campo}: longitudine fuori da -180..180`)
	if (!Number.isFinite(lat) || lat < -90 || lat > 90) throwErrorWrongUserInput(`${campo}: latitudine fuori da -90..90`)

	return [lng, lat]
}
