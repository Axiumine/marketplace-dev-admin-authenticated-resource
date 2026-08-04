import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const create = vi.fn()
const funImprenditoreDelete = vi.fn()
const funImprenditoreUpdate = vi.fn()
const funImprenditoreUpdateEmail = vi.fn()
const funImprenditoreUpdateNote = vi.fn()
const funImprenditoreUpdatePreferenze = vi.fn()
const funImprenditoreUpdateStato = vi.fn()
const funPuntoVenditaAdd = vi.fn()
const funPuntoVenditaDelete = vi.fn()
const funPuntoVenditaUpdate = vi.fn()
const funPuntoVenditaUpdateStato = vi.fn()
const funAziendaAdd = vi.fn()
const funAziendaDelete = vi.fn()
const funAziendaUpdate = vi.fn()
const funAdminUpdatePwd = vi.fn()
const captureException = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore', () => ({ Imprenditore: { create } }))
vi.mock('@lib/imprenditore/funImprenditoreDelete.mjs', () => ({ funImprenditoreDelete }))
vi.mock('@lib/imprenditore/funImprenditoreUpdate.mjs', () => ({ funImprenditoreUpdate }))
vi.mock('@lib/imprenditore/funImprenditoreUpdateEmail.mjs', () => ({ funImprenditoreUpdateEmail }))
vi.mock('@lib/imprenditore/funImprenditoreUpdateNote.mjs', () => ({ funImprenditoreUpdateNote }))
vi.mock('@lib/imprenditore/funImprenditoreUpdatePreferenze.mjs', () => ({ funImprenditoreUpdatePreferenze }))
vi.mock('@lib/imprenditore/funImprenditoreUpdateStato.mjs', () => ({ funImprenditoreUpdateStato }))
vi.mock('@lib/puntoVendita/funPuntoVenditaAdd.mjs', () => ({ funPuntoVenditaAdd }))
vi.mock('@lib/puntoVendita/funPuntoVenditaDelete.mjs', () => ({ funPuntoVenditaDelete }))
vi.mock('@lib/puntoVendita/funPuntoVenditaUpdate.mjs', () => ({ funPuntoVenditaUpdate }))
vi.mock('@lib/puntoVendita/funPuntoVenditaUpdateStato.mjs', () => ({ funPuntoVenditaUpdateStato }))
vi.mock('@lib/azienda/funAziendaAdd.mjs', () => ({ funAziendaAdd }))
vi.mock('@lib/azienda/funAziendaDelete.mjs', () => ({ funAziendaDelete }))
vi.mock('@lib/azienda/funAziendaUpdate.mjs', () => ({ funAziendaUpdate }))
vi.mock('@lib/admin/funAdminUpdatePwd.mjs', () => ({ funAdminUpdatePwd }))
// tryCatchRethrow is NOT mocked — the point of these tests is that a failure really travels
// through it. Only its Sentry sink is stubbed.
//
// The `@lib/validate/*` modules are NOT mocked either, and that is the same decision one layer down:
// the mutations' contract with them is that a bad field never reaches the database and a good one
// arrives normalised, which a stub asserts nothing about.
vi.mock('@sentry/node', () => ({ captureException }))

const { adminUpdatePwd } = await import('../src/graphQLApi/schema/mutations/adminUpdatePwd.mts')
const { aziendaAdd } = await import('../src/graphQLApi/schema/mutations/aziendaAdd.mts')
const { aziendaDel } = await import('../src/graphQLApi/schema/mutations/aziendaDel.mts')
const { aziendaUpdate } = await import('../src/graphQLApi/schema/mutations/aziendaUpdate.mts')
const { imprenditoreAdd } = await import('../src/graphQLApi/schema/mutations/imprenditoreAdd.mts')
const { imprenditoreDel } = await import('../src/graphQLApi/schema/mutations/imprenditoreDel.mts')
const { imprenditoreUpdate } = await import('../src/graphQLApi/schema/mutations/imprenditoreUpdate.mts')
const { imprenditoreUpdateEmail } = await import('../src/graphQLApi/schema/mutations/imprenditoreUpdateEmail.mts')
const { imprenditoreUpdateNote } = await import('../src/graphQLApi/schema/mutations/imprenditoreUpdateNote.mts')
const { imprenditoreUpdatePreferenze } = await import('../src/graphQLApi/schema/mutations/imprenditoreUpdatePreferenze.mts')
const { imprenditoreUpdateStato } = await import('../src/graphQLApi/schema/mutations/imprenditoreUpdateStato.mts')
const { puntoVenditaAdd } = await import('../src/graphQLApi/schema/mutations/puntoVenditaAdd.mts')
const { puntoVenditaDel } = await import('../src/graphQLApi/schema/mutations/puntoVenditaDel.mts')
const { puntoVenditaUpdate } = await import('../src/graphQLApi/schema/mutations/puntoVenditaUpdate.mts')
const { puntoVenditaUpdateStato } = await import('../src/graphQLApi/schema/mutations/puntoVenditaUpdateStato.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')
const login = { email: 'shop@marketplace.test', password: 'clear' } as never
const ctx = { state: { user: { _id, email: 'operator@marketplace.test' } } } as never

/**
 * A complete, already-valid anagrafica.
 *
 * It has to be complete now that `imprenditoreUpdate` validates before writing — the two-field stub
 * this used to be is rejected at `nascita.data` before the resolver reaches the lib, which is the
 * validator doing its job and not a fixture worth keeping.
 */
const anagrafica = {
	nome: 'Mario',
	cognome: 'Rossi',
	nascita: { data: new Date('1990-05-17T00:00:00.000Z') },
	indirizzo: { indirizzo: 'Via Roma 1', cap: '20100', comune: 'Milano', provincia: 'MI' },
	contatti: { cellulare: '3331234567', email: 'mario@marketplace.test' }
} as never

// The insegna and the ragione sociale, kept deliberately different: they are two fields, and a fixture
// that gave them one value would let a resolver send the wrong one with every assertion still green.
const nome = 'Da Mario'

// What `puntoVendita.idAzienda` is since 20260803000100: a reference, picked from the owner's live
// companies, and not the company's fields retyped on every shop of the chain. The migration renamed the
// path as it retyped it, which is why the mutation argument is `idAzienda` while the output field that
// resolves the company itself is still `azienda`.
const idAzienda = new Types.ObjectId('507f1f77bcf86cd799439014')

const indirizzo = {
	indirizzo: 'Via Milano 9',
	cap: '20100',
	comune: 'Milano',
	provincia: 'MI',
	position: { coordinates: [9.19, 45.46] }
} as never

/** A complete, already-valid company, as `GraphQLInputAzienda` delivers it — seat included. */
const azienda = {
	ragionesociale: 'Pizzeria da Mario S.r.l.',
	piva: '12345678901',
	cf: '12345678901',
	referente: 'Mario Rossi',
	amministratore: 'Mario Rossi',
	univoco: 'ABC1234',
	pec: 'pizzeria@pec.test',
	indirizzo,
	visura: 'visura-2026'
} as never

const contatti = { cellulare: '3331234567' } as never
const orari = [{ giorno: 'Lun', da: new Date('1970-01-01T11:30:00.000Z'), a: new Date('1970-01-01T15:00:00.000Z') }] as never

describe('adminUpdatePwd', () => {
	beforeEach(() => {
		funAdminUpdatePwd.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// The account changed is the one the request is authenticated as. There is no `_id` argument to
	// pass, and there must not be: every operator authenticates against the same collection and the
	// platform has no role field, so a client-supplied id would turn this into "change any
	// operator's password". The assertion is that the id comes off ctx.state.user, which is written
	// by the Redis session lookup in the auth middleware and is not reachable from the request body.
	it('changes the password of the session account and answers true', async () => {
		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'vecchia1234', passwordNew: 'nuova12345' }, ctx)).resolves.toBe(
			true
		)

		expect(funAdminUpdatePwd).toHaveBeenCalledExactlyOnceWith(_id, 'vecchia1234', 'nuova12345')
	})

	// A rejected old password must reach the client as the 401 the lib raised, not be flattened into
	// a generic 500 — and must not be reported to Sentry, since it is a normal outcome.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwUnauthorizedError } = await import('@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError')
		funAdminUpdatePwd.mockImplementationOnce(() => throwUnauthorizedError())

		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'vecchia1234', passwordNew: 'nuova12345' }, ctx)).rejects.toThrow(
			'Unauthorized'
		)
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('mongo down')
		funAdminUpdatePwd.mockRejectedValueOnce(error)

		await expect(adminUpdatePwd.resolve(null, { passwordOld: 'vecchia1234', passwordNew: 'nuova12345' }, ctx)).rejects.toThrow(
			'Internal Server Error'
		)
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('imprenditoreAdd', () => {
	beforeEach(() => {
		create.mockReset().mockResolvedValue({ _id })
		captureException.mockReset()
	})

	// iscrizione is stamped server-side, never taken from the client.
	it('creates the imprenditore and answers true', async () => {
		await expect(imprenditoreAdd.resolve(null, { login, anagrafica })).resolves.toBe(true)

		const [doc] = create.mock.calls[0]
		expect(doc.login).toBe(login)
		// `toEqual`, not `toBe`: the anagrafica written is the validator's return value, a new object.
		// It is deliberately not the argument — see the normalisation test below.
		expect(doc.anagrafica).toEqual(anagrafica)
		expect(doc.iscrizione).toBeInstanceOf(Date)
	})

	// Same contract `imprenditoreUpdate` has, and it has to be the same: both mutations take the one
	// shared input type, so anything the update path normalises can arrive here too. Untrimmed text is
	// trimmed, a lower-case provincia is upper-cased, a blank landline is dropped from the object
	// rather than written as null, and the address point — which the client sends as coordinates only
	// — gets the `type: 'Point'` the collection requires.
	it('normalises the anagrafica before it is written', async () => {
		await expect(
			imprenditoreAdd.resolve(null, {
				login,
				anagrafica: {
					...anagrafica,
					nome: '  Mario  ',
					indirizzo: { ...anagrafica.indirizzo, provincia: 'mi', position: { coordinates: [9.19, 45.46] } },
					contatti: { ...anagrafica.contatti, fisso: '   ' }
				}
			})
		).resolves.toBe(true)

		const [doc] = create.mock.calls[0]
		expect(doc.anagrafica.nome).toBe('Mario')
		expect(doc.anagrafica.indirizzo.provincia).toBe('MI')
		expect(doc.anagrafica.indirizzo.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
		expect('fisso' in doc.anagrafica.contatti).toBe(false)
	})

	// The validator raising is a 400 the operator can act on, and it must not reach `create` at all —
	// nor Sentry, which is for bugs and not for a mistyped form.
	it('refuses an invalid anagrafica without touching the database', async () => {
		expect(await rejection(imprenditoreAdd.resolve(null, { login, anagrafica: { ...anagrafica, nome: '   ' } }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'nome: campo obbligatorio'
		})

		expect(create).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports a driver failure to Sentry and answers a generic 500', async () => {
		const error = new Error('duplicate key')
		create.mockRejectedValueOnce(error)

		await expect(imprenditoreAdd.resolve(null, { login, anagrafica })).rejects.toThrow('Internal Server Error')
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('imprenditoreDel', () => {
	beforeEach(() => {
		funImprenditoreDelete.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('soft-deletes the imprenditore and answers true', async () => {
		await expect(imprenditoreDel.resolve(null, { _id })).resolves.toBe(true)
		expect(funImprenditoreDelete).toHaveBeenCalledExactlyOnceWith(_id)
	})

	it('propagates the failure', async () => {
		funImprenditoreDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(imprenditoreDel.resolve(null, { _id })).rejects.toThrow('Internal Server Error')
	})
})

describe('imprenditoreUpdate', () => {
	beforeEach(() => {
		funImprenditoreUpdate.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('updates the anagrafica and answers true', async () => {
		await expect(imprenditoreUpdate.resolve(null, { _id, anagrafica })).resolves.toBe(true)
		expect(funImprenditoreUpdate).toHaveBeenCalledExactlyOnceWith(_id, anagrafica)
	})

	// `toEqual`, and a fixture that is deliberately messy: the resolver passes on the validator's
	// **return value**, not its argument, so this is the assertion that would fail if someone
	// "simplified" it back to `validaAnagraficaImprenditore(...); await fun(_id, args.anagrafica)`.
	// A cleared `fisso` must be gone from the object rather than present holding undefined — the
	// collection validator rejects the whole write otherwise.
	it('writes the normalised anagrafica, not the one that arrived', async () => {
		await expect(
			imprenditoreUpdate.resolve(null, {
				_id,
				anagrafica: {
					...(anagrafica as object),
					nome: '  Mario  ',
					indirizzo: { indirizzo: 'Via Roma 1', cap: '20100', comune: 'Milano', provincia: 'mi' },
					contatti: { cellulare: '3331234567', fisso: '   ', email: 'mario@marketplace.test' }
				} as never
			})
		).resolves.toBe(true)

		const [, scritta] = funImprenditoreUpdate.mock.calls[0]
		expect(scritta.nome).toBe('Mario')
		expect(scritta.indirizzo.provincia).toBe('MI')
		expect(Object.keys(scritta.contatti)).toEqual(['cellulare', 'email'])
	})

	// The 400 has to happen *before* the write, not be reported after one — an imprenditore whose
	// anagrafica was replaced by a rejected one is exactly the failure the validator exists to stop.
	it('rejects an invalid anagrafica with a 400 and never reaches the database', async () => {
		const esito = await rejection(
			imprenditoreUpdate.resolve(null, {
				_id,
				anagrafica: {
					...(anagrafica as object),
					indirizzo: { ...(anagrafica as never as { indirizzo: object }).indirizzo, cap: '2010' }
				} as never
			})
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'indirizzo.cap: il CAP è di 5 cifre'
		})
		expect(funImprenditoreUpdate).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	// A GraphQLError raised deeper down keeps its own status instead of being flattened to 500 —
	// that branch of tryCatchRethrow is only reachable through a resolver like this one.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwAccessTokenExpiredOrDeleted } =
			await import('@axiumine/koa-utils/graphQL/throw/throwAccessTokenExpiredOrDeleted')
		funImprenditoreUpdate.mockImplementationOnce(() => throwAccessTokenExpiredOrDeleted())

		await expect(imprenditoreUpdate.resolve(null, { _id, anagrafica })).rejects.toThrow('Invalid Token')
		expect(captureException).not.toHaveBeenCalled()
	})
})

describe('imprenditoreUpdateEmail', () => {
	beforeEach(() => {
		funImprenditoreUpdateEmail.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('trims the address before storing it', async () => {
		await expect(imprenditoreUpdateEmail.resolve(null, { _id, email: '  nuova@marketplace.test ' })).resolves.toBe(true)
		expect(funImprenditoreUpdateEmail).toHaveBeenCalledExactlyOnceWith(_id, 'nuova@marketplace.test')
	})

	it('refuses a malformed address without touching the database', async () => {
		expect(await rejection(imprenditoreUpdateEmail.resolve(null, { _id, email: 'nuova@marketplace' }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'email: indirizzo email non valido'
		})

		expect(funImprenditoreUpdateEmail).not.toHaveBeenCalled()
	})

	// The collision is a 409 the operator can act on, not a 500 — and it must not page anyone.
	it('passes a duplicate-address conflict through with its own status', async () => {
		const { throwAlreadyTakenError } = await import('@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError')
		funImprenditoreUpdateEmail.mockImplementationOnce(() => throwAlreadyTakenError('email: già registrata'))

		expect(await rejection(imprenditoreUpdateEmail.resolve(null, { _id, email: 'nuova@marketplace.test' }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'email: già registrata'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('reports an unexpected failure to Sentry and answers a generic 500', async () => {
		const error = new Error('mongo down')
		funImprenditoreUpdateEmail.mockRejectedValueOnce(error)

		await expect(imprenditoreUpdateEmail.resolve(null, { _id, email: 'nuova@marketplace.test' })).rejects.toThrow(
			'Internal Server Error'
		)
		expect(captureException).toHaveBeenCalledWith(error)
	})
})

describe('imprenditoreUpdateStato', () => {
	beforeEach(() => {
		funImprenditoreUpdateStato.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// Both flags travel exactly as sent — `false` is a value here, not an omission, which is why the
	// arguments are non-null in the schema.
	it.each([
		[true, true],
		[true, false],
		[false, true],
		[false, false]
	])('forwards disabled=%s waitApprov=%s unchanged', async (disabled, waitApprov) => {
		await expect(imprenditoreUpdateStato.resolve(null, { _id, disabled, waitApprov })).resolves.toBe(true)
		expect(funImprenditoreUpdateStato).toHaveBeenCalledExactlyOnceWith(_id, disabled, waitApprov)
	})

	it('propagates the failure', async () => {
		funImprenditoreUpdateStato.mockRejectedValueOnce(new Error('mongo down'))

		await expect(imprenditoreUpdateStato.resolve(null, { _id, disabled: true, waitApprov: false })).rejects.toThrow(
			'Internal Server Error'
		)
	})
})

describe('imprenditoreUpdateNote', () => {
	beforeEach(() => {
		funImprenditoreUpdateNote.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('trims the note before storing it', async () => {
		await expect(imprenditoreUpdateNote.resolve(null, { _id, note: '  Richiamare a settembre  ' })).resolves.toBe(true)
		expect(funImprenditoreUpdateNote).toHaveBeenCalledExactlyOnceWith(_id, 'Richiamare a settembre')
	})

	// The empty string is a value here, not an omission: it is how the operator clears the note, and
	// the lib turns it into an `$unset`. A box holding only spaces means the same thing and has to
	// arrive the same way — the argument is `String!` precisely so this state has one spelling.
	it.each([[''], ['   '], ['\n\t']])('passes %p through as the clear instruction', async (note) => {
		await expect(imprenditoreUpdateNote.resolve(null, { _id, note })).resolves.toBe(true)
		expect(funImprenditoreUpdateNote).toHaveBeenCalledExactlyOnceWith(_id, '')
	})

	// The collection caps `note` at 2000. Over that the write would be rejected by MongoDB as a 500
	// with nothing the operator could act on, so the 400 has to be raised here, before the database.
	it('refuses a note past the collection bound without touching the database', async () => {
		expect(await rejection(imprenditoreUpdateNote.resolve(null, { _id, note: 'N'.repeat(2001) }))).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'note: massimo 2000 caratteri'
		})

		expect(funImprenditoreUpdateNote).not.toHaveBeenCalled()
		expect(captureException).not.toHaveBeenCalled()
	})

	it('accepts a note exactly at the bound', async () => {
		await expect(imprenditoreUpdateNote.resolve(null, { _id, note: 'N'.repeat(2000) })).resolves.toBe(true)
		expect(funImprenditoreUpdateNote).toHaveBeenCalledExactlyOnceWith(_id, 'N'.repeat(2000))
	})

	it('propagates the failure', async () => {
		funImprenditoreUpdateNote.mockRejectedValueOnce(new Error('mongo down'))

		await expect(imprenditoreUpdateNote.resolve(null, { _id, note: 'x' })).rejects.toThrow('Internal Server Error')
	})
})

describe('imprenditoreUpdatePreferenze', () => {
	beforeEach(() => {
		funImprenditoreUpdatePreferenze.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('trims the onboarding step', async () => {
		await expect(
			imprenditoreUpdatePreferenze.resolve(null, { _id, rememberMe: true, onboardingDone: false, onboardingStep: ' 3 ' })
		).resolves.toBe(true)

		expect(funImprenditoreUpdatePreferenze).toHaveBeenCalledExactlyOnceWith(_id, true, false, '3')
	})

	// `null`, `undefined` and a box holding only spaces are one state — "not set" — and all three have
	// to arrive as `undefined`, because that is what the lib turns into an `$unset`. `null` reaches the
	// collection as a value of the wrong type for a `string` property and fails the whole write.
	it.each([[null], [undefined], ['   ']])('treats %p as no step at all', async (onboardingStep) => {
		await expect(
			imprenditoreUpdatePreferenze.resolve(null, { _id, rememberMe: false, onboardingDone: true, onboardingStep })
		).resolves.toBe(true)

		expect(funImprenditoreUpdatePreferenze).toHaveBeenCalledExactlyOnceWith(_id, false, true, undefined)
	})

	it('refuses a step longer than the collection allows', async () => {
		const esito = await rejection(
			imprenditoreUpdatePreferenze.resolve(null, { _id, rememberMe: true, onboardingDone: true, onboardingStep: '12345' })
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'onboardingStep: massimo 4 caratteri'
		})
		expect(funImprenditoreUpdatePreferenze).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funImprenditoreUpdatePreferenze.mockRejectedValueOnce(new Error('mongo down'))

		await expect(
			imprenditoreUpdatePreferenze.resolve(null, { _id, rememberMe: true, onboardingDone: true, onboardingStep: '2' })
		).rejects.toThrow('Internal Server Error')
	})
})

/**
 * The shop payload both writes hand to the lib. `puntoVenditaAdd` and `puntoVenditaUpdate` differ in
 * their first argument — the owner's id versus the shop's own — but the second is the same five
 * fields, `position.type` among them: the input carries coordinates alone and the resolver stamps
 * the GeoJSON type, which is the single most important claim in either test.
 */
function expectDatiPuntoVendita(dati: {
	indirizzo: { position: unknown }
	nome: unknown
	idAzienda: unknown
	contatti: unknown
	orari: unknown
}) {
	expect(dati.indirizzo.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	expect(dati.nome).toBe(nome)
	expect(dati.idAzienda).toBe(idAzienda)
	expect(dati.contatti).toEqual(contatti)
	expect(dati.orari).toEqual(orari)
}

describe('puntoVenditaUpdate', () => {
	beforeEach(() => {
		funPuntoVenditaUpdate.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// The `position.type` the client never sent is what the resolver writes — the whole reason the
	// input carries coordinates alone.
	it('writes the insegna, the company reference and all three sub-documents at once, stamping the GeoJSON type itself', async () => {
		await expect(puntoVenditaUpdate.resolve(null, { _id, nome, idAzienda, indirizzo, contatti, orari })).resolves.toBe(true)

		const [id, dati] = funPuntoVenditaUpdate.mock.calls[0]
		expect(id).toBe(_id)
		expectDatiPuntoVendita(dati)
	})

	// A shop that has not published its hours is a real state the read side already renders.
	it('accepts an empty list of opening hours', async () => {
		await expect(puntoVenditaUpdate.resolve(null, { _id, nome, idAzienda, indirizzo, contatti, orari: [] })).resolves.toBe(true)
		expect(funPuntoVenditaUpdate.mock.calls[0][1].orari).toEqual([])
	})

	// Validation of every box happens before the single write, so a bad opening time cannot leave the
	// address already saved.
	it('rejects the whole save when one field is invalid', async () => {
		const esito = await rejection(
			puntoVenditaUpdate.resolve(null, {
				_id,
				nome,
				idAzienda,
				indirizzo,
				contatti,
				orari: [{ giorno: '', da: new Date(), a: new Date() }] as never
			})
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'orari[0].giorno: campo obbligatorio'
		})
		expect(funPuntoVenditaUpdate).not.toHaveBeenCalled()
	})

	// The insegna is validated on the same footing as the boxes, not waved through because it is one
	// string: it is required in the collection, so a blank one saved would be a document MongoDB refuses
	// and an error the operator reads as "mongo down" rather than as "give the shop a name".
	it('refuses a blank insegna', async () => {
		const esito = await rejection(puntoVenditaUpdate.resolve(null, { _id, nome: '   ', idAzienda, indirizzo, contatti, orari }))

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'nome: campo obbligatorio'
		})
		expect(funPuntoVenditaUpdate).not.toHaveBeenCalled()
	})

	// `validaIndirizzo` takes the path prefix as an argument because `aziendaUpdate` calls it too, with
	// `azienda.indirizzo`. Here it must be `indirizzo`: the shop form has two address boxes on the same
	// page — the shop's and, read-only, its company's — so a message that named neither would point the
	// operator at whichever one they looked at first.
	it('names the shop’s own address box in the error path', async () => {
		const esito = await rejection(
			puntoVenditaUpdate.resolve(null, {
				_id,
				nome,
				idAzienda,
				indirizzo: { ...(indirizzo as object), cap: 'ABCDE' } as never,
				contatti,
				orari
			})
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'indirizzo.cap: il CAP è di 5 cifre'
		})
		expect(funPuntoVenditaUpdate).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funPuntoVenditaUpdate.mockRejectedValueOnce(new Error('mongo down'))

		await expect(puntoVenditaUpdate.resolve(null, { _id, nome, idAzienda, indirizzo, contatti, orari })).rejects.toThrow(
			'Internal Server Error'
		)
	})
})

describe('puntoVenditaAdd', () => {
	beforeEach(() => {
		funPuntoVenditaAdd.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// The owner travels as an argument and the GeoJSON type does not travel at all — the two ways this
	// resolver differs from every other write on the tier. `idImprenditore` comes off the operator's URL
	// rather than off the session, which is why the lib checks it exists; `position.type` is stamped by
	// the validator, which is why the input has no field for it.
	it('creates the shop under the imprenditore it was given, stamping the GeoJSON type itself', async () => {
		await expect(
			puntoVenditaAdd.resolve(null, { idImprenditore: _id, nome, idAzienda, indirizzo, contatti, orari })
		).resolves.toBe(true)

		const [proprietario, dati] = funPuntoVenditaAdd.mock.calls[0]
		expect(proprietario).toBe(_id)
		expectDatiPuntoVendita(dati)
	})

	// A shop can be created before its week is filled in — the read side already renders "Nessun orario
	// impostato" and the collection puts no `minItems` on the list.
	it('accepts an empty list of opening hours', async () => {
		await expect(
			puntoVenditaAdd.resolve(null, { idImprenditore: _id, nome, idAzienda, indirizzo, contatti, orari: [] })
		).resolves.toBe(true)
		expect(funPuntoVenditaAdd.mock.calls[0][1].orari).toEqual([])
	})

	// Nothing is created when one box is wrong, which is why all of them are validated ahead of the single
	// insert rather than each one on its way into the document.
	it('rejects the whole insert when one field is invalid', async () => {
		const esito = await rejection(
			puntoVenditaAdd.resolve(null, {
				idImprenditore: _id,
				nome,
				idAzienda,
				indirizzo,
				contatti,
				orari: [{ giorno: '', da: new Date(), a: new Date() }] as never
			})
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'orari[0].giorno: campo obbligatorio'
		})
		expect(funPuntoVenditaAdd).not.toHaveBeenCalled()
	})

	// Same gate on the create path: a shop cannot be born nameless, and the cap is the collection's.
	it('refuses an insegna over the cap', async () => {
		const esito = await rejection(
			puntoVenditaAdd.resolve(null, {
				idImprenditore: _id,
				nome: 'a'.repeat(101),
				idAzienda,
				indirizzo,
				contatti,
				orari
			})
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'nome: massimo 100 caratteri'
		})
		expect(funPuntoVenditaAdd).not.toHaveBeenCalled()
	})

	// The 404 the lib raises for an owner that does not exist has to reach the client as a 404: it is the
	// one outcome an operator can act on, and flattening it into a 500 would also report a mistyped URL
	// to Sentry as a platform failure.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwNotFoundError } = await import('@axiumine/koa-utils/graphQL/throw/throwNotFoundError')
		funPuntoVenditaAdd.mockImplementationOnce(() => throwNotFoundError('imprenditore non trovato'))

		expect(
			await rejection(puntoVenditaAdd.resolve(null, { idImprenditore: _id, nome, idAzienda, indirizzo, contatti, orari }))
		).toEqual({ message: 'Oops', http: { status: 404 }, description: 'imprenditore non trovato' })
		expect(captureException).not.toHaveBeenCalled()
	})

	// Same prefix, same reason as on the update: `indirizzo`, not the company's `azienda.indirizzo`.
	it('names the shop’s own address box in the error path', async () => {
		const esito = await rejection(
			puntoVenditaAdd.resolve(null, {
				idImprenditore: _id,
				nome,
				idAzienda,
				indirizzo: { ...(indirizzo as object), cap: 'ABCDE' } as never,
				contatti,
				orari
			})
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'indirizzo.cap: il CAP è di 5 cifre'
		})
		expect(funPuntoVenditaAdd).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funPuntoVenditaAdd.mockRejectedValueOnce(new Error('mongo down'))

		await expect(
			puntoVenditaAdd.resolve(null, { idImprenditore: _id, nome, idAzienda, indirizzo, contatti, orari })
		).rejects.toThrow('Internal Server Error')
	})
})

describe('aziendaAdd', () => {
	beforeEach(() => {
		funAziendaAdd.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// Same two peculiarities as `puntoVenditaAdd`: the owner is an argument, because the session is the
	// operator's, and the seat's `position.type` is stamped by the validator rather than sent.
	it('creates the company under the imprenditore it was given, normalised', async () => {
		await expect(aziendaAdd.resolve(null, { idImprenditore: _id, azienda })).resolves.toBe(true)

		const [proprietario, dati] = funAziendaAdd.mock.calls[0]
		expect(proprietario).toBe(_id)
		expect(dati.ragionesociale).toBe('Pizzeria da Mario S.r.l.')
		expect(dati.indirizzo.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	})

	it('rejects the whole insert when one field is invalid', async () => {
		const esito = await rejection(
			aziendaAdd.resolve(null, { idImprenditore: _id, azienda: { ...(azienda as object), piva: '123' } as never })
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'azienda.piva: la partita IVA è di 11 cifre'
		})
		expect(funAziendaAdd).not.toHaveBeenCalled()
	})

	// The 409 the lib raises on a duplicate partita IVA is the one an operator can act on, and it must not
	// reach Sentry: a company already registered is a normal outcome, not a platform failure.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwAlreadyTakenError } = await import('@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError')
		funAziendaAdd.mockImplementationOnce(() => throwAlreadyTakenError('partita IVA o PEC già registrate da un’altra azienda'))

		expect(await rejection(aziendaAdd.resolve(null, { idImprenditore: _id, azienda }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'partita IVA o PEC già registrate da un’altra azienda'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funAziendaAdd.mockRejectedValueOnce(new Error('mongo down'))

		await expect(aziendaAdd.resolve(null, { idImprenditore: _id, azienda })).rejects.toThrow('Internal Server Error')
	})
})

describe('aziendaUpdate', () => {
	beforeEach(() => {
		funAziendaUpdate.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// ⚠️ No owner, neither as an argument nor inside the input — which is what keeps a company from being
	// handed to another imprenditore, taking its shops with it, by editing its card.
	it('rewrites the company by id, without touching its owner', async () => {
		await expect(aziendaUpdate.resolve(null, { _id, azienda })).resolves.toBe(true)

		const [id, dati] = funAziendaUpdate.mock.calls[0]
		expect(id).toBe(_id)
		expect('idImprenditore' in dati).toBe(false)
		expect(dati.indirizzo.position).toEqual({ type: 'Point', coordinates: [9.19, 45.46] })
	})

	// The seat is validated with the company's own prefix, so the operator is told which of the two
	// addresses on the page is wrong.
	it('rejects the whole save when the seat is invalid', async () => {
		const esito = await rejection(
			aziendaUpdate.resolve(null, {
				_id,
				azienda: { ...(azienda as object), indirizzo: { ...(indirizzo as object), cap: 'ABCDE' } } as never
			})
		)

		expect(esito).toEqual({
			message: 'Bad Request',
			http: { status: 400 },
			description: 'azienda.indirizzo.cap: il CAP è di 5 cifre'
		})
		expect(funAziendaUpdate).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funAziendaUpdate.mockRejectedValueOnce(new Error('mongo down'))

		await expect(aziendaUpdate.resolve(null, { _id, azienda })).rejects.toThrow('Internal Server Error')
	})
})

describe('aziendaDel', () => {
	beforeEach(() => {
		funAziendaDelete.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('deletes the company by id and answers true', async () => {
		await expect(aziendaDel.resolve(null, { _id })).resolves.toBe(true)

		expect(funAziendaDelete).toHaveBeenCalledExactlyOnceWith(_id)
	})

	// The refusal an operator meets when the company still has shops: a 409 with a message that says what
	// to do about it, and nothing reported to Sentry.
	it('preserves the status of a GraphQLError raised downstream', async () => {
		const { throwConflictError } = await import('@axiumine/koa-utils/graphQL/throw/throwConflictError')
		funAziendaDelete.mockImplementationOnce(() => throwConflictError('azienda ancora collegata a uno o più punti vendita'))

		expect(await rejection(aziendaDel.resolve(null, { _id }))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'azienda ancora collegata a uno o più punti vendita'
		})
		expect(captureException).not.toHaveBeenCalled()
	})

	it('propagates the failure', async () => {
		funAziendaDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(aziendaDel.resolve(null, { _id })).rejects.toThrow('Internal Server Error')
	})
})

describe('puntoVenditaDel', () => {
	beforeEach(() => {
		funPuntoVenditaDelete.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	it('soft-deletes the punto vendita and answers true', async () => {
		await expect(puntoVenditaDel.resolve(null, { _id })).resolves.toBe(true)
		expect(funPuntoVenditaDelete).toHaveBeenCalledExactlyOnceWith(_id)
	})

	it('propagates the failure', async () => {
		funPuntoVenditaDelete.mockRejectedValueOnce(new Error('mongo down'))

		await expect(puntoVenditaDel.resolve(null, { _id })).rejects.toThrow('Internal Server Error')
	})
})

describe('puntoVenditaUpdateStato', () => {
	beforeEach(() => {
		funPuntoVenditaUpdateStato.mockReset().mockResolvedValue(undefined)
		captureException.mockReset()
	})

	// The operator flag travels exactly as sent — `false` is a value here, not an omission, which is why
	// the argument is non-null in the schema. Only `disabledByAdmin` is forwarded; the resolver has no
	// way to reach the owner's `disabled`.
	it.each([[true], [false]])('forwards disabledByAdmin=%s unchanged', async (disabledByAdmin) => {
		await expect(puntoVenditaUpdateStato.resolve(null, { _id, disabledByAdmin })).resolves.toBe(true)
		expect(funPuntoVenditaUpdateStato).toHaveBeenCalledExactlyOnceWith(_id, disabledByAdmin)
	})

	it('propagates the failure', async () => {
		funPuntoVenditaUpdateStato.mockRejectedValueOnce(new Error('mongo down'))

		await expect(puntoVenditaUpdateStato.resolve(null, { _id, disabledByAdmin: true })).rejects.toThrow('Internal Server Error')
	})
})
