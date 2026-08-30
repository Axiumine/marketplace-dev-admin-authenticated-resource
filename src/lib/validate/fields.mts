import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'

/**
 * The field-level checks the update mutations run before touching MongoDB.
 *
 * They exist because the collection's `$jsonSchema` is the only thing that was enforcing any of this,
 * and a validator rejection surfaces as a raw driver error: `Document failed validation`, with the
 * offending path buried in `errInfo`. Apollo turns that into a 500 with no usable message, so an
 * admin who typed a four-digit postal code was told the server had broken. Every helper below raises a 400
 * naming the field instead.
 *
 * They also **normalise**, and that half is not cosmetic. `additionalProperties: false` plus
 * `bsonType: 'string'` means an optional contact sent as `null` — which is exactly what a cleared text
 * box serialises to over GraphQL — fails the write. `optionalText` answers `undefined` for anything
 * blank, so the key is simply absent from the `$set` document.
 *
 * The bounds are copied from the migrations, not from koa-utils. They are not the same numbers: the
 * platform's `EMAIL_MAX_LEN` is 255 while every email-shaped path in these two collections is capped at
 * 250, so validating against koa-utils would pass a 253-character address straight into a rejection.
 */

/** Every email-shaped path in `shopOwner` and `company`. NOT koa-utils' 255 — see above. */
export const MAX_EMAIL = 250

/**
 * Deliberately loose: one `@`, a dot in the domain, no whitespace.
 *
 * A stricter address grammar belongs nowhere near a validator whose only job is to keep obvious
 * rubbish out of the database — RFC 5322 admits addresses this would be wrong to reject, and the real
 * proof an address exists is a delivered email, which the platform already does elsewhere.
 */
export const SHAPE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const SHAPE_POSTAL_CODE = /^\d{5}$/
export const SHAPE_PROVINCE = /^[A-Za-z]{2}$/
export const SHAPE_VAT_NUMBER = /^\d{11}$/
export const SHAPE_UNIQUE_CODE = /^[A-Za-z0-9]{7}$/

/**
 * A URL segment: lowercase letters, digits, single hyphens between them.
 *
 * The exact pattern the three slug-bearing collections carry (`company.slug`, `item.slug`,
 * `itemCategory.slug`) — copied from the migrations, like every other bound in this file, and not
 * loosened. No leading, trailing or doubled hyphen, no uppercase, no dot and no slash: a slug lands in
 * a public route, where an uppercase letter is a different URL after normalisation and a slash is a
 * different route altogether. Both are worse than a rejected write, because they surface as a 404 on a
 * page an admin believed they had published.
 *
 * `minLength: 2` in all three collections, so the pattern alone is not enough — the length helpers
 * below carry it.
 */
export const SHAPE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Every slug on the platform, shortest first: two characters. */
export const MIN_SLUG = 2

/** Age of majority. A shop owner signs contracts, so the platform has no under-18 accounts. */
export const MIN_AGE = 18

/**
 * A required text field: trimmed, non-empty, within the collection's `maxLength`.
 *
 * Trimmed *before* the length test, so 250 characters of address plus a trailing space is an address
 * and not an overflow, and a box holding four spaces is empty rather than four characters long.
 */
export const requiredText = (value: string, field: string, max: number): string => {
	const clean = value.trim()

	if (clean.length === 0) throwErrorWrongUserInput(`${field}: field required`)
	if (clean.length > max) throwErrorWrongUserInput(`${field}: max ${max} characters`)

	return clean
}

/**
 * An optional text field.
 *
 * Blank comes back `undefined` — never `''` and never `null`. Both of those reach the collection as a
 * value of the wrong type for a `bsonType: 'string'` property and fail the whole write, which is how a
 * cleared landline number takes an otherwise valid save down with it.
 */
export const optionalText = (value: string | null | undefined, field: string, max: number): string | undefined => {
	const clean = (value ?? '').trim()

	if (clean.length === 0) return undefined
	if (clean.length > max) throwErrorWrongUserInput(`${field}: max ${max} characters`)

	return clean
}

/**
 * A required text field that also has to match a shape.
 *
 * No separate empty test: every `FORMA_*` above is anchored and matches at least one character, so the
 * empty string fails the pattern and gets the same 400 with a message that says what was expected.
 */
export const textWithFormat = (value: string, field: string, shape: RegExp, expected: string): string => {
	const clean = value.trim()

	if (!shape.test(clean)) throwErrorWrongUserInput(`${field}: ${expected}`)

	return clean
}

/**
 * An optional text field the collection pins to one exact length — `company.taxCode` is the only one.
 *
 * Its own helper rather than `optionalTextWithFormat` with a `/^.{11}$/`: `.` does not match a
 * newline, so a pattern would reject an eleven-character value the collection accepts. Length is also
 * all that was asked for — the tax code of a company is the 11-digit form, but the collection
 * constrains `minLength`/`maxLength` and no alphabet, and inventing one here would reject a value the
 * database takes.
 *
 * Blank comes back `undefined`, like every other optional field: a cleared box has to be absent from
 * the `$set`, not present as an empty string that fails `minLength: 11`.
 */
export const optionalTextExactLength = (value: string | null | undefined, field: string, length: number): string | undefined => {
	const clean = (value ?? '').trim()

	if (clean.length === 0) return undefined
	if (clean.length !== length) throwErrorWrongUserInput(`${field}: exactly ${length} characters`)

	return clean
}

/** As above, for a field that may be left blank — `company.uniqueCode` is the only one. */
export const optionalTextWithFormat = (
	value: string | null | undefined,
	field: string,
	shape: RegExp,
	expected: string
): string | undefined => {
	const clean = (value ?? '').trim()

	if (clean.length === 0) return undefined
	if (!shape.test(clean)) throwErrorWrongUserInput(`${field}: ${expected}`)

	return clean
}

/**
 * A required slug: trimmed, within the collection's bounds, shaped like a URL segment.
 *
 * Not lowercased for the caller. An admin who typed `Northwind` is told the slug is lowercase
 * rather than having it silently rewritten — the slug is the permanent address of a public page, and a
 * value that differs from what was typed is the kind of surprise that gets noticed only after the link
 * has been shared.
 */
export const requiredSlug = (value: string, field: string, max: number): string => {
	const clean = requiredText(value, field, max)

	if (clean.length < MIN_SLUG) throwErrorWrongUserInput(`${field}: min ${MIN_SLUG} characters`)

	return textWithFormat(clean, field, SHAPE_SLUG, 'lowercase letters, digits and single hyphens only')
}

/** As above, for a slug that may be left blank — `company.slug` is the only one. */
export const optionalSlug = (value: string | null | undefined, field: string, max: number): string | undefined => {
	const clean = optionalText(value, field, max)

	return clean === undefined ? undefined : requiredSlug(clean, field, max)
}

export const requiredEmail = (value: string, field: string): string =>
	textWithFormat(requiredText(value, field, MAX_EMAIL), field, SHAPE_EMAIL, 'invalid email address')

/**
 * The latest birth date that is already `MIN_AGE` years old on `today`.
 *
 * UTC throughout. `birth.date` arrives from graphql-scalars' `Date`, which parses `YYYY-MM-DD` to
 * midnight UTC, so reading the calendar parts locally would move the boundary by the server's offset
 * and put the birthday on the wrong side of it for half the world.
 *
 * `Date.UTC` rolls an impossible day forward — 29 February minus 18 years lands in a non-leap year and
 * becomes 1 March, which would accept someone whose eighteenth birthday is tomorrow. `setUTCDate(0)`
 * steps back to the last day of the intended month instead.
 */
const limitBirth = (today: Date): Date => {
	const month = today.getUTCMonth()
	const limit = new Date(Date.UTC(today.getUTCFullYear() - MIN_AGE, month, today.getUTCDate()))

	if (limit.getUTCMonth() !== month) limit.setUTCDate(0)

	return limit
}

/**
 * A birth date that is a real date and belongs to someone of age.
 *
 * `today` is a parameter rather than a `new Date()` inside, so the boundary can be tested on both sides
 * without freezing the clock. The boundary is inclusive: someone turning 18 today is 18 today.
 */
export const birthDate = (date: Date, field: string, today: Date): Date => {
	if (Number.isNaN(date.getTime())) throwErrorWrongUserInput(`${field}: invalid date`)

	if (date.getTime() > limitBirth(today).getTime()) {
		throwErrorWrongUserInput(`${field}: the shopOwner must be of age (at least ${MIN_AGE})`)
	}

	return date
}

/**
 * A GeoJSON coordinate pair, `[longitude, latitude]` — longitude first.
 *
 * The two axes get different bounds, matching what the `20260801000000` migration put in the (now-gone
 * shop collection's) validator: ±180 for longitude, ±90 for latitude. A single ±180 rule for both is the
 * bug that migration fixed, and re-introducing it here would let a latitude of 120 through to a
 * `2dsphere` index that cannot key it.
 *
 * `Number.isFinite` looks redundant because `GraphQLFloat` refuses NaN and Infinity at the schema
 * boundary, and through the API it is. It stays because without it the two range tests answer `false`
 * for NaN and wave it through — this helper is exported and unit-tested on its own, and one that is
 * only correct when called from one place is worth less than the comparison costs.
 */
export const coordinate = (coordinates: readonly number[], field: string): number[] => {
	if (coordinates.length !== 2) {
		throwErrorWrongUserInput(`${field}: exactly 2 coordinates are required [longitude, latitude]`)
	}

	const [lng, lat] = coordinates as [number, number]

	if (!Number.isFinite(lng) || lng < -180 || lng > 180) throwErrorWrongUserInput(`${field}: longitude outside -180..180`)
	if (!Number.isFinite(lat) || lat < -90 || lat > 90) throwErrorWrongUserInput(`${field}: latitude outside -90..90`)

	return [lng, lat]
}
