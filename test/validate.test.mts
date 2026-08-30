import { Types } from 'mongoose'
import { describe, expect, it } from 'vitest'

import { failure, reason } from './errors.mts'

const {
	coordinate,
	birthDate,
	requiredEmail,
	MIN_AGE,
	SHAPE_POSTAL_CODE,
	SHAPE_EMAIL,
	SHAPE_VAT_NUMBER,
	SHAPE_PROVINCE,
	SHAPE_UNIQUE_CODE,
	MAX_EMAIL,
	textWithFormat,
	requiredText,
	optionalText,
	optionalTextWithFormat,
	optionalTextExactLength
} = await import('../src/lib/validate/fields.mts')

const { validateShopOwnerPersonalData } = await import('../src/lib/validate/validateShopOwnerPersonalData.mts')

const { validateShopOwnerNote } = await import('../src/lib/validate/validateShopOwnerNote.mts')

const { validateDisabledReason, MAX_DISABLED_REASON } = await import('../src/lib/validate/validateDisabledReason.mts')

const { validateCompany } = await import('../src/lib/validate/validateCompany.mts')

const { validateAddress } = await import('../src/lib/validate/validateAddress.mts')

const { validateItemCategory } = await import('../src/lib/validate/validateItemCategory.mts')

/** An address of exactly `MAX_EMAIL` characters: 244 of local part, plus the six of `@ex.it`. */
const emailAtLimit = `${'a'.repeat(MAX_EMAIL - 6)}@ex.it`

describe('requiredText', () => {
	it('trims before measuring, so trailing spaces are neither content nor overflow', () => {
		expect(requiredText('  Mark  ', 'firstName', 5)).toBe('Mark')
	})

	it.each([
		['an empty string', '', 'firstName: field required'],
		['a box holding only spaces', '     ', 'firstName: field required'],
		['one character over the cap', 'abcdef', 'firstName: max 5 characters'],
		['a long value whose trailing spaces do not save it', '  abcdef  ', 'firstName: max 5 characters']
	])('refuses %s', (_desc, value, expected) => {
		expect(reason(() => requiredText(value, 'firstName', 5))).toBe(expected)
	})

	// The cap is inclusive: `maxLength: 5` in the collection accepts five characters, so the validator
	// that guards it has to accept them too, or it rejects values the database would have taken.
	it('accepts a value of exactly the maximum length', () => {
		expect(requiredText('abcde', 'firstName', 5)).toBe('abcde')
	})
})

describe('optionalTextExactLength', () => {
	it('trims and returns a value of exactly the required length', () => {
		expect(optionalTextExactLength('  12345678901  ', 'company.taxCode', 11)).toBe('12345678901')
	})

	// Same absence rule as every other optional field: a cleared box has to be *absent* from the `$set`,
	// not present as an empty string that fails the collection's `minLength: 11`.
	it.each([[null], [undefined], [''], ['    ']])('reads %p as not given', (value) => {
		expect(optionalTextExactLength(value, 'company.taxCode', 11)).toBeUndefined()
	})

	// One character on either side, because a `!==` written as `<` or `>` passes half the cases.
	it.each([
		['one character short', '1234567890'],
		['one character over', '123456789012']
	])('refuses %s', (_desc, value) => {
		expect(reason(() => optionalTextExactLength(value, 'company.taxCode', 11))).toBe('company.taxCode: exactly 11 characters')
	})

	// No alphabet: the collection constrains `minLength`/`maxLength` and nothing else, and a pattern
	// invented here would reject a value the database takes. A newline counts as a character for the
	// same reason — which is why this is its own helper rather than `optionalTextWithFormat` with a
	// `/^.{11}$/`, since `.` does not match one.
	it.each([['ABCDEFGHIJK'], ['12345\n67890']])('accepts %p, since only the length is pinned', (value) => {
		expect(optionalTextExactLength(value, 'company.taxCode', 11)).toHaveLength(11)
	})
})

describe('optionalText', () => {
	// All three spellings of "not given" have to collapse to `undefined`, because that is the only one
	// the caller can leave out of the `$set` document — `null` and `''` both reach a `bsonType: 'string'`
	// property and fail the whole write.
	it.each([[null], [undefined], [''], ['    ']])('reads %p as not given', (value) => {
		expect(optionalText(value, 'landline', 12)).toBeUndefined()
	})

	it('trims a value that was given', () => {
		expect(optionalText('  0212345  ', 'landline', 12)).toBe('0212345')
	})

	it('accepts a value of exactly the maximum length', () => {
		expect(optionalText('123456789012', 'landline', 12)).toBe('123456789012')
	})

	it('refuses one character over the cap', () => {
		expect(reason(() => optionalText('1234567890123', 'landline', 12))).toBe('landline: max 12 characters')
	})
})

describe('textWithFormat', () => {
	it('trims and returns a value that matches', () => {
		expect(textWithFormat('  02109  ', 'postalCode', SHAPE_POSTAL_CODE, 'the postal code is 5 digits')).toBe('02109')
	})

	// No separate empty test in the source: every pattern is anchored and matches at least one
	// character, so a blank field gets the shape message rather than "field required".
	it('refuses a blank value with the shape message, not an obligatory one', () => {
		expect(reason(() => textWithFormat('   ', 'postalCode', SHAPE_POSTAL_CODE, 'the postal code is 5 digits'))).toBe(
			'postalCode: the postal code is 5 digits'
		)
	})
})

describe('optionalTextWithFormat', () => {
	it.each([[null], [undefined], ['   ']])('reads %p as not given, without running the pattern', (value) => {
		expect(optionalTextWithFormat(value, 'uniqueCode', SHAPE_UNIQUE_CODE, 'seven characters')).toBeUndefined()
	})

	it('trims and returns a value that matches', () => {
		expect(optionalTextWithFormat(' ABC1234 ', 'uniqueCode', SHAPE_UNIQUE_CODE, 'seven characters')).toBe('ABC1234')
	})

	it('refuses a value that was given and does not match', () => {
		expect(reason(() => optionalTextWithFormat('ABC12', 'uniqueCode', SHAPE_UNIQUE_CODE, 'seven characters'))).toBe(
			'uniqueCode: seven characters'
		)
	})
})

/*
 * The patterns, one table each.
 *
 * Every table carries a value that is right, a value that is the wrong length on each side, a value
 * with the wrong character class, and — the two that are easy to leave out — a value with something
 * glued to the front and one with something glued to the back. Those last two are what an unanchored
 * pattern would let through: `/\d{5}/` without `^` accepts `street 02109`, and without `$` it accepts
 * `02109 Boston`, both of which look like they matched.
 */
describe('the field patterns', () => {
	it.each([
		['02109', true],
		['00100', true],
		['2010', false],
		['201000', false],
		['2010a', false],
		['abcde', false],
		['', false],
		['x20100', false],
		['20100x', false],
		[' 20100', false]
	])('SHAPE_POSTAL_CODE accepts %p: %s', (value, expected) => {
		expect(SHAPE_POSTAL_CODE.test(value)).toBe(expected)
	})

	it.each([
		['MA', true],
		['ma', true],
		['Mi', true],
		['M', false],
		['MIL', false],
		['M1', false],
		['12', false],
		['', false],
		['xMI', false],
		['MIx', false],
		['M I', false]
	])('SHAPE_PROVINCE accepts %p: %s', (value, expected) => {
		expect(SHAPE_PROVINCE.test(value)).toBe(expected)
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
	])('SHAPE_VAT_NUMBER accepts %p: %s', (value, expected) => {
		expect(SHAPE_VAT_NUMBER.test(value)).toBe(expected)
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
	])('SHAPE_UNIQUE_CODE accepts %p: %s', (value, expected) => {
		expect(SHAPE_UNIQUE_CODE.test(value)).toBe(expected)
	})

	// Deliberately loose — one `@`, a dot after it, no whitespace. The rows below are the rubbish it is
	// meant to stop, not an attempt at RFC 5322.
	it.each([
		['mark@marketplace.test', true],
		['m.rivers+tag@sub.marketplace.co.uk', true],
		['a@b.c', true],
		['mark@marketplace', false],
		['markmarketplace.test', false],
		['@marketplace.test', false],
		['mark@.test', false],
		['mark@marketplace.', false],
		['mark@@marketplace.test', false],
		['ma rio@marketplace.test', false],
		['mark@marketplace.test ', false],
		[' mark@marketplace.test', false],
		['', false]
	])('SHAPE_EMAIL accepts %p: %s', (value, expected) => {
		expect(SHAPE_EMAIL.test(value)).toBe(expected)
	})
})

describe('emailObbligatoria', () => {
	it('trims and returns a well-formed address', () => {
		expect(requiredEmail('  mark@marketplace.test ', 'contacts.email')).toBe('mark@marketplace.test')
	})

	// The cap is the collection's 250, not koa-utils' platform-wide 255: validating against the wrong
	// one would pass a 253-character address into a driver rejection with no readable message.
	it('accepts an address of exactly 250 characters', () => {
		expect(requiredEmail(emailAtLimit, 'contacts.email')).toBe(emailAtLimit)
		expect(MAX_EMAIL).toBe(250)
	})

	it.each([
		['a blank box', '   ', 'contacts.email: field required'],
		['one character over the cap', `x${emailAtLimit}`, 'contacts.email: max 250 characters'],
		['a malformed address', 'mark@marketplace', 'contacts.email: invalid email address']
	])('refuses %s', (_desc, value, expected) => {
		expect(reason(() => requiredEmail(value, 'contacts.email'))).toBe(expected)
	})
})

describe('birthDate', () => {
	const today = new Date('2026-08-02T00:00:00.000Z')

	it('accepts a date comfortably in the past', () => {
		const data = new Date('1990-05-17T00:00:00.000Z')

		expect(birthDate(data, 'birth.date', today)).toBe(data)
	})

	// Inclusive on purpose: someone turning 18 today is 18 today. This is also the row that dies if the
	// comparison is loosened to `>=`, or if the leap-year correction is applied unconditionally.
	it('accepts someone whose eighteenth birthday is today', () => {
		const data = new Date('2008-08-02T00:00:00.000Z')

		expect(birthDate(data, 'birth.date', today)).toBe(data)
	})

	it('refuses someone whose eighteenth birthday is tomorrow', () => {
		expect(reason(() => birthDate(new Date('2008-08-03T00:00:00.000Z'), 'birth.date', today))).toBe(
			'birth.date: the shopOwner must be of age (at least 18)'
		)
		expect(MIN_AGE).toBe(18)
	})

	it('refuses a date that is not a date', () => {
		expect(reason(() => birthDate(new Date('non una data'), 'birth.date', today))).toBe('birth.date: invalid date')
	})

	/*
	 * The one case `Date.UTC` gets wrong on its own. 29 February minus 18 years is 29 February 2006,
	 * which does not exist, and `Date.UTC` rolls it forward to 1 March — a limit one day *later* than
	 * intended, which admits someone whose birthday has not happened yet. `setUTCDate(0)` steps back to
	 * 28 February instead.
	 */
	describe('on 29 February', () => {
		const leapYear = new Date('2024-02-29T00:00:00.000Z')

		it('puts the limit on 28 February, not 1 March', () => {
			const data = new Date('2006-02-28T00:00:00.000Z')

			expect(birthDate(data, 'birth.date', leapYear)).toBe(data)
		})

		it('refuses the day the rollover would have let through', () => {
			expect(reason(() => birthDate(new Date('2006-03-01T00:00:00.000Z'), 'birth.date', leapYear))).toBe(
				'birth.date: the shopOwner must be of age (at least 18)'
			)
		})
	})
})

describe('coordinate', () => {
	it('returns the pair, longitude first', () => {
		expect(coordinate([9.19, 45.46], 'pos')).toEqual([9.19, 45.46])
	})

	it.each([[[]], [[9.19]], [[9.19, 45.46, 120]]])('refuses %p, which is not a pair', (coordinates) => {
		expect(reason(() => coordinate(coordinates, 'pos'))).toBe('pos: exactly 2 coordinates are required [longitude, latitude]')
	})

	// The two axes have different bounds — that asymmetry is what the collection's own validator carries,
	// and a single ±180 rule here would put a latitude of 120 into a 2dsphere index that cannot key it.
	it.each([[[-180, 0]], [[180, 0]], [[0, -90]], [[0, 90]]])('accepts %p, exactly on the boundary', (coordinates) => {
		expect(coordinate(coordinates, 'pos')).toEqual(coordinates)
	})

	it.each([[[-180.1, 0]], [[180.1, 0]], [[Number.NaN, 0]], [[Number.POSITIVE_INFINITY, 0]]])(
		'refuses %p for its longitude',
		(coordinates) => {
			expect(reason(() => coordinate(coordinates, 'pos'))).toBe('pos: longitude outside -180..180')
		}
	)

	it.each([[[0, -90.1]], [[0, 90.1]], [[0, Number.NaN]], [[0, Number.NEGATIVE_INFINITY]]])(
		'refuses %p for its latitude',
		(coordinates) => {
			expect(reason(() => coordinate(coordinates, 'pos'))).toBe('pos: latitude outside -90..90')
		}
	)
})

describe('validateShopOwnerPersonalData', () => {
	const today = new Date('2026-08-02T00:00:00.000Z')
	const birth = { date: new Date('1990-05-17T00:00:00.000Z') }

	const validate = {
		firstName: '  Mark  ',
		lastName: ' Rivers ',
		birth,
		address: { street: ' 1 Main Street ', postalCode: ' 02109 ', city: ' Boston ', province: 'ma' },
		contacts: { mobile: ' 3331234567 ', landline: ' 0212345 ', email: ' mark@marketplace.test ' }
	} as never

	it('returns a trimmed copy with the province upper-cased', () => {
		expect(validateShopOwnerPersonalData(validate, today)).toEqual({
			firstName: 'Mark',
			lastName: 'Rivers',
			birth: { date: birth.date },
			address: { street: '1 Main Street', postalCode: '02109', city: 'Boston', province: 'MA' },
			contacts: { mobile: '3331234567', landline: '0212345', email: 'mark@marketplace.test' }
		})
	})

	// `$set: { personalData }` replaces the whole sub-document, so a cleared landline has to be *absent*
	// from the returned object. Present holding `undefined` is serialised to `null` by the BSON writer
	// and fails the collection validator, taking the rest of the save with it.
	it('drops a cleared landline instead of writing it empty', () => {
		const withoutLandline = validateShopOwnerPersonalData(
			{ ...(validate as object), contacts: { mobile: '3331234567', landline: '   ', email: 'mark@marketplace.test' } } as never,
			today
		)

		expect(Object.keys(withoutLandline.contacts)).toEqual(['mobile', 'email'])
		expect('landline' in withoutLandline.contacts).toBe(false)
	})

	// One row per field, so a validator wired to the wrong argument — the copy-paste failure this shape
	// of code invites — shows up as the wrong field name in the message rather than as a passing test.
	it.each([
		['firstName', { firstName: '' }, 'firstName: field required'],
		['lastName', { lastName: '  ' }, 'lastName: field required'],
		['firstName over the cap', { firstName: 'a'.repeat(101) }, 'firstName: max 100 characters'],
		['lastName over the cap', { lastName: 'a'.repeat(101) }, 'lastName: max 100 characters'],
		[
			'birth.date',
			{ birth: { date: new Date('2020-01-01T00:00:00.000Z') } },
			'birth.date: the shopOwner must be of age (at least 18)'
		]
	])('refuses a bad %s', (_desc, patch, expected) => {
		expect(reason(() => validateShopOwnerPersonalData({ ...(validate as object), ...patch } as never, today))).toBe(expected)
	})

	it.each([
		['address.street', { street: '' }, 'address.street: field required'],
		['address.street over the cap', { street: 'a'.repeat(251) }, 'address.street: max 250 characters'],
		['address.postalCode', { postalCode: '2010' }, 'address.postalCode: the postal code is 5 digits'],
		['address.city', { city: '   ' }, 'address.city: field required'],
		['address.province', { province: 'MIL' }, 'address.province: the province is the 2-letter code']
	])('refuses a bad %s', (_desc, patch, expected) => {
		const personalData = {
			...(validate as object),
			address: { ...(validate as never as { address: object }).address, ...patch }
		} as never

		expect(reason(() => validateShopOwnerPersonalData(personalData, today))).toBe(expected)
	})

	it.each([
		['contacts.mobile', { mobile: '' }, 'contacts.mobile: field required'],
		['contacts.mobile over the cap', { mobile: '1234567890123' }, 'contacts.mobile: max 12 characters'],
		['contacts.landline over the cap', { landline: '1234567890123' }, 'contacts.landline: max 12 characters'],
		['contacts.email', { email: 'mark@marketplace' }, 'contacts.email: invalid email address']
	])('refuses a bad %s', (_desc, patch, expected) => {
		const personalData = {
			...(validate as object),
			contacts: { ...(validate as never as { contacts: object }).contacts, ...patch }
		} as never

		expect(reason(() => validateShopOwnerPersonalData(personalData, today))).toBe(expected)
	})

	// The input type carries the coordinates alone; the `type: 'Point'` the collection validator requires
	// is added here, so the client never sends a constant it could get wrong.
	it('wraps the coordinates in a GeoJSON point', () => {
		const withPosition = validateShopOwnerPersonalData(
			{
				...(validate as object),
				address: {
					...(validate as never as { address: object }).address,
					position: { coordinates: [9.19, 45.46] }
				}
			} as never,
			today
		)

		expect(withPosition.address.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	})

	// `position` is optional in the collection and nothing backfills it, so every shopOwner created
	// before 20260802000300 still has none. Absent has to stay absent: `$set: { personalData }` replaces the
	// whole sub-document, and a key present holding `undefined` is written as `null`, which the validator
	// rejects — taking the rest of the save with it, exactly as a cleared landline would.
	it.each([
		['absent', {}],
		['null', { position: null }],
		['undefined', { position: undefined }]
	])('omits the point entirely when it is %s', (_desc, patch) => {
		const withoutPosition = validateShopOwnerPersonalData(
			{
				...(validate as object),
				address: { ...(validate as never as { address: object }).address, ...patch }
			} as never,
			today
		)

		expect('position' in withoutPosition.address).toBe(false)
	})

	// The bounds themselves are `coordinate`'s, tested above; what this pins is the path prefix, which is
	// the only part of the message this function contributes.
	it.each([
		[[9.19], 'address.position.coordinates: exactly 2 coordinates are required [longitude, latitude]'],
		[[9.19, 120], 'address.position.coordinates: latitude outside -90..90'],
		[[190, 45.46], 'address.position.coordinates: longitude outside -180..180']
	])('refuses %p, naming the nested path', (coordinates, expected) => {
		const personalData = {
			...(validate as object),
			address: { ...(validate as never as { address: object }).address, position: { coordinates } }
		} as never

		expect(reason(() => validateShopOwnerPersonalData(personalData, today))).toBe(expected)
	})
})

describe('validateDisabledReason', () => {
	it('returns the reason trimmed when the account is being suspended', () => {
		expect(validateDisabledReason(true, '  Repeated chargebacks  ')).toBe('Repeated chargebacks')
	})

	/*
	 * ⚠️ **A suspension owes a sentence, and the empty spellings are one case.** ADR-044's whole point is
	 * that the account can say why, and the collection cannot help: `dependencies` asserts the field is
	 * present and reads nothing, so `''` would satisfy it. `requiredText` is what refuses all four.
	 */
	it.each([[''], ['   '], [null], [undefined]])('refuses %p beside disabled: true', (reasonText) => {
		expect(reason(() => validateDisabledReason(true, reasonText))).toBe('disabledReason: field required')
	})

	/*
	 * ⚠️ **A reason sent with a release is dropped, not refused.** The mutation's contract is a target
	 * state rather than a transition, so a form that kept its textarea populated while the admin
	 * unticked the box is describing "not suspended" — and answering that with a 400 would be the service
	 * arguing with a request it understood. `undefined` is what `funShopOwnerUpdateStatus` turns into the
	 * `$unset` that clears the stored reason.
	 */
	it.each([['Repeated chargebacks'], [''], [null], [undefined]])('discards %p beside disabled: false', (reasonText) => {
		expect(validateDisabledReason(false, reasonText)).toBeUndefined()
	})

	it('accepts a reason of exactly 1000 characters', () => {
		expect(validateDisabledReason(true, 'a'.repeat(MAX_DISABLED_REASON))).toHaveLength(MAX_DISABLED_REASON)
	})

	/*
	 * ⚠️ **This service is the only thing enforcing the cap on the platform.** `disabledReason` is
	 * `ALGORITHM_RANDOM`-encrypted, so it reaches MongoDB as `binData` and `$jsonSchema` admits no
	 * `maxLength` on a blob — a write that bypasses this function can exceed 1000 and nothing downstream
	 * will notice.
	 */
	it('refuses a reason over the cap', () => {
		expect(reason(() => validateDisabledReason(true, 'a'.repeat(MAX_DISABLED_REASON + 1)))).toBe(
			'disabledReason: max 1000 characters'
		)
	})

	it('raises a 400 rather than a generic failure', () => {
		expect(failure(() => validateDisabledReason(true, ''))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'disabledReason: field required'
		})
	})
})

describe('validateShopOwnerNote', () => {
	it('returns the note trimmed', () => {
		expect(validateShopOwnerNote('  Richiamare a settembre  ')).toBe('Richiamare a settembre')
	})

	// `''`, not `undefined`: the caller writes it straight into `funShopOwnerUpdateNote`, which reads
	// the empty string as "remove the field". `optionalText` alone would hand back `undefined` and the
	// `$unset` branch would never be taken.
	it.each([[''], ['   '], ['\n\t']])('turns %p into the empty string that clears the note', (note) => {
		expect(validateShopOwnerNote(note)).toBe('')
	})

	it('accepts a note of exactly 2000 characters', () => {
		expect(validateShopOwnerNote('a'.repeat(2000))).toHaveLength(2000)
	})

	// The collection caps `notes` at 2000; over it the driver would answer with an opaque validation
	// failure, so the bound is restated here to name the field.
	it('refuses a note over the cap', () => {
		expect(reason(() => validateShopOwnerNote('a'.repeat(2001)))).toBe('notes: max 2000 characters')
	})

	it('raises a 400 rather than a generic failure', () => {
		expect(failure(() => validateShopOwnerNote('a'.repeat(2001)))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'notes: max 2000 characters'
		})
	})
})

describe('validateAddress', () => {
	const valid = {
		street: ' 9 Harbour Road ',
		postalCode: ' 02109 ',
		city: ' Boston ',
		province: 'ma',
		position: { coordinates: [9.19, 45.46] }
	}

	// `type` is written, never read off the argument: there is one legal value, so accepting it from the
	// client would only create a way to get it wrong.
	it('stamps the GeoJSON type itself and upper-cases the province', () => {
		expect(validateAddress(valid, 'address')).toEqual({
			street: '9 Harbour Road',
			postalCode: '02109',
			city: 'Boston',
			province: 'MA',
			position: { type: 'Point', coordinates: [9.19, 45.46] }
		})
	})

	// ⚠️ The prefix is the whole reason this takes a second argument: one validator serves both the
	// shopOwner address and the company seat, and the admin has to be told which of the two addresses
	// on the page is wrong.
	it('names the path it was given, so the same failure reads differently for each address', () => {
		expect(reason(() => validateAddress({ ...valid, postalCode: 'ABCDE' }, 'address'))).toBe(
			'address.postalCode: the postal code is 5 digits'
		)
		expect(reason(() => validateAddress({ ...valid, postalCode: 'ABCDE' }, 'company.address'))).toBe(
			'company.address.postalCode: the postal code is 5 digits'
		)
	})

	// ⚠️ 100 here, 250 on an shopOwner. Same field name, same GraphQL fragment, different collections.
	it('caps the street address at 100, not at the shopOwner’s 250', () => {
		expect(validateAddress({ ...valid, street: 'a'.repeat(100) }, 'address').street).toHaveLength(100)
		expect(reason(() => validateAddress({ ...valid, street: 'a'.repeat(101) }, 'address'))).toBe(
			'address.street: max 100 characters'
		)
	})

	it.each([
		['street', { street: '  ' }, 'address.street: field required'],
		['postalCode', { postalCode: 'ABCDE' }, 'address.postalCode: the postal code is 5 digits'],
		['city', { city: '' }, 'address.city: field required'],
		['city over the cap', { city: 'a'.repeat(101) }, 'address.city: max 100 characters'],
		['province', { province: '1' }, 'address.province: the province is the 2-letter code'],
		[
			'position',
			{ position: { coordinates: [9.19] } },
			'address.position.coordinates: exactly 2 coordinates are required [longitude, latitude]'
		],
		['latitude', { position: { coordinates: [9.19, 120] } }, 'address.position.coordinates: latitude outside -90..90']
	])('refuses a bad %s', (_desc, patch, expected) => {
		expect(reason(() => validateAddress({ ...valid, ...patch }, 'address'))).toBe(expected)
	})
})

describe('validateCompany', () => {
	const address = {
		street: ' 9 Harbour Road ',
		postalCode: ' 02109 ',
		city: ' Boston ',
		province: 'ma',
		position: { coordinates: [9.19, 45.46] }
	}

	const validate = {
		legalName: ' Marks Boutique ',
		vatNumber: ' 12345678901 ',
		taxCode: ' 12345678901 ',
		contactPerson: ' Mark Rivers ',
		administrator: ' Mark Rivers ',
		uniqueCode: ' ABC1234 ',
		certifiedEmail: ' certified@boutique.test ',
		address,
		registryExtract: ' registryExtract-2026 '
		// No `published`: it left `GraphQLInputCompany` when publishing became its own operation, so the
		// validator is never handed one. The three public fields are genuinely optional and are exercised
		// on their own below.
	} as never

	it('returns a trimmed copy, with the seat normalised like any other address', () => {
		expect(validateCompany(validate)).toEqual({
			legalName: 'Marks Boutique',
			vatNumber: '12345678901',
			taxCode: '12345678901',
			contactPerson: 'Mark Rivers',
			administrator: 'Mark Rivers',
			uniqueCode: 'ABC1234',
			certifiedEmail: 'certified@boutique.test',
			address: {
				street: '9 Harbour Road',
				postalCode: '02109',
				city: 'Boston',
				province: 'MA',
				position: { type: 'Point', coordinates: [9.19, 45.46] }
			},
			registryExtract: 'registryExtract-2026'
		})
	})

	// ⚠️ The flag is dropped, not passed through: `companyUpdate` `$set`s this object whole, so a
	// `published` surviving validation would make every save of the card a write of the flag — which is
	// exactly what `companyUpdatePublished` exists to stop. Asserted against an input that carries one,
	// because a caller reaching the resolver past the schema is the case that matters.
	it('drops a published flag that reached it anyway', () => {
		expect(validateCompany({ ...(validate as object), published: true } as never)).not.toHaveProperty('published')
	})

	// The two optional fields, and the same absence rule as a landline: a key present holding `undefined`
	// is written as `null` by the BSON writer and fails the collection validator, taking the save with it.
	it.each([
		['taxCode', { taxCode: '  ' }],
		['uniqueCode', { uniqueCode: '   ' }],
		['both', { taxCode: '', uniqueCode: null }]
	])('drops a blank %s instead of writing it empty', (_desc, patch) => {
		const result = validateCompany({ ...(validate as object), ...patch } as never)

		expect(Object.keys(result)).toEqual(
			[
				'legalName',
				'vatNumber',
				'taxCode',
				'contactPerson',
				'administrator',
				'uniqueCode',
				'certifiedEmail',
				'address',
				'registryExtract'
			].filter((k) => !(k in patch))
		)
	})

	// The shop listing, from 20260804000200. All three are optional because a company exists as a legal
	// entity long before its admin writes a public page for it — and nothing here checks them against
	// `published`, on purpose twice over: the flag is not this path's to write at all, and the
	// collection's `$expr` refuses `published: true` without a slug and a publicName, which is the copy
	// of the rule no write can bypass.
	it('carries the three public fields through, trimmed, when the shop has a listing', () => {
		const result = validateCompany({
			...(validate as object),
			publicName: ' Mark Boutique ',
			slug: ' mark-boutique ',
			description: ' Wood oven since 1975. '
		} as never)

		expect(result.publicName).toBe('Mark Boutique')
		expect(result.slug).toBe('mark-boutique')
		expect(result.description).toBe('Wood oven since 1975.')
	})

	// ⚠️ The slug is the permanent address of a public page, so a value that differs from what was typed
	// is refused rather than silently rewritten: an admin who typed `Boutique` is told the slug is
	// lowercase, instead of finding out after the link has been shared. `--` is rejected by the same
	// shape — a doubled hyphen comes from a name with punctuation in it and is not what a reader expects
	// to see in a URL.
	it.each([
		['publicName over the cap', { publicName: 'a'.repeat(101) }, 'company.publicName: max 100 characters'],
		['an uppercase slug', { slug: 'Boutique' }, 'company.slug: lowercase letters, digits and single hyphens only'],
		['a doubled hyphen', { slug: 'mark--boutique' }, 'company.slug: lowercase letters, digits and single hyphens only'],
		['a one-character slug', { slug: 'a' }, 'company.slug: min 2 characters'],
		['slug over the cap', { slug: 'a'.repeat(121) }, 'company.slug: max 120 characters'],
		['description over the cap', { description: 'a'.repeat(2001) }, 'company.description: max 2000 characters']
	])('refuses %s', (_desc, patch, expected) => {
		expect(reason(() => validateCompany({ ...(validate as object), ...patch } as never))).toBe(expected)
	})

	// ⚠️ 1000, and it is the collection's cap rather than an invented one — the field was the single
	// unbounded string on the embedded shape until 20260803000000 put a `maxLength` on it.
	it('accepts a registryExtract of exactly 1000 characters and refuses 1001', () => {
		expect(
			validateCompany({ ...(validate as object), registryExtract: 'x'.repeat(1000) } as never).registryExtract
		).toHaveLength(1000)
		expect(reason(() => validateCompany({ ...(validate as object), registryExtract: 'x'.repeat(1001) } as never))).toBe(
			'company.registryExtract: max 1000 characters'
		)
	})

	it.each([
		['legalName', { legalName: '' }, 'company.legalName: field required'],
		['legalName over the cap', { legalName: 'a'.repeat(101) }, 'company.legalName: max 100 characters'],
		['vatNumber', { vatNumber: '1234567890' }, 'company.vatNumber: the VAT number is 11 digits'],
		['taxCode', { taxCode: '1234567890' }, 'company.taxCode: exactly 11 characters'],
		['contactPerson', { contactPerson: '   ' }, 'company.contactPerson: field required'],
		['contactPerson over the cap', { contactPerson: 'a'.repeat(51) }, 'company.contactPerson: max 50 characters'],
		['administrator', { administrator: '' }, 'company.administrator: field required'],
		['administrator over the cap', { administrator: 'a'.repeat(51) }, 'company.administrator: max 50 characters'],
		['uniqueCode', { uniqueCode: 'ABC12' }, 'company.uniqueCode: the unique code is 7 alphanumeric characters'],
		['certifiedEmail', { certifiedEmail: 'boutique@certifiedEmail' }, 'company.certifiedEmail: invalid email address'],
		['registryExtract', { registryExtract: '   ' }, 'company.registryExtract: field required']
	])('refuses a bad %s', (_desc, patch, expected) => {
		expect(reason(() => validateCompany({ ...(validate as object), ...patch } as never))).toBe(expected)
	})

	// The seat's own failures come through with the company's prefix, which is what keeps them apart from
	// the shop address sitting in the same form.
	it.each([
		['street', { street: '  ' }, 'company.address.street: field required'],
		['postalCode', { postalCode: 'ABCDE' }, 'company.address.postalCode: the postal code is 5 digits'],
		[
			'position',
			{ position: { coordinates: [9.19] } },
			'company.address.position.coordinates: exactly 2 coordinates are required [longitude, latitude]'
		]
	])('refuses a bad seat %s, naming the nested path', (_desc, patch, expected) => {
		expect(reason(() => validateCompany({ ...(validate as object), address: { ...address, ...patch } } as never))).toBe(expected)
	})
})

describe('validateItemCategory', () => {
	const idParent = new Types.ObjectId('507f1f77bcf86cd799439030')

	const validate = { name: ' Footwear ', slug: ' footwear-goods ', idParent, position: 3 } as never

	it('returns a trimmed copy, keeping the parent it was handed', () => {
		expect(validateItemCategory(validate)).toEqual({
			name: 'Footwear',
			slug: 'footwear-goods',
			idParent,
			position: 3
		})
	})

	// ⚠️ `idParent` is passed through untouched and nothing here invents one. Whether it names a category that
	// exists, is live and is itself top-level takes three database reads, so all three live in
	// `throwIfParentNotTopLevel` — this layer only guarantees the shape.
	//
	// Absent means absent, in both spellings: GraphQL serialises a cleared box to `null`, and the
	// collection declares `bsonType: 'objectId'` under `additionalProperties: false`, so a null written
	// through would fail the whole save.
	it.each([
		['undefined', undefined],
		['null', null]
	])('drops an %s idParent instead of writing it', (_desc, absent) => {
		const result = validateItemCategory({ ...(validate as object), idParent: absent } as never)

		expect(Object.keys(result)).toEqual(['name', 'slug', 'position'])
	})

	// ⚠️ `position` is checked here rather than left to the collection because `bsonType: 'int'` answers
	// `Document failed validation` and names no field — which Apollo turns into a 500 the admin cannot
	// act on. Zero is the first legal ordinal and 0.5 is the failure the collection would have swallowed.
	it.each([
		['zero', 0],
		['a large ordinal', 9999]
	])('accepts %s as a position', (_desc, position) => {
		expect(validateItemCategory({ ...(validate as object), position } as never).position).toBe(position)
	})

	// The floor is inclusive, and two characters is a real slug — `it`, `hi`, a two-letter brand. A `<=`
	// written where the `<` belongs rejects them all while every longer slug keeps working, which is the
	// kind of bound nobody notices until a category refuses to save.
	it('accepts a slug of exactly the minimum length', () => {
		expect(validateItemCategory({ ...(validate as object), slug: 'ab' } as never).slug).toBe('ab')
	})

	it.each([
		['a fractional position', { position: 1.5 }, 'itemCategory.position: whole number required'],
		['a non-numeric position', { position: 'first' }, 'itemCategory.position: whole number required'],
		// Negative sorts before everything and means nothing; `minimum: 0` is the collection's own bound.
		['a negative position', { position: -1 }, 'itemCategory.position: cannot be negative'],
		['a blank name', { name: '   ' }, 'itemCategory.name: field required'],
		['a name over the cap', { name: 'a'.repeat(101) }, 'itemCategory.name: max 100 characters'],
		['a blank slug', { slug: '' }, 'itemCategory.slug: field required'],
		// ⚠️ 120 against the name's 100, and the gap is deliberate: a slug is derived from a name and
		// hyphens make it grow, so a 100-character name that survives `requiredText` must still fit.
		['a slug over the cap', { slug: 'a'.repeat(121) }, 'itemCategory.slug: max 120 characters'],
		['an uppercase slug', { slug: 'Footwear' }, 'itemCategory.slug: lowercase letters, digits and single hyphens only']
	])('refuses %s', (_desc, patch, expected) => {
		expect(reason(() => validateItemCategory({ ...(validate as object), ...patch } as never))).toBe(expected)
	})
})
