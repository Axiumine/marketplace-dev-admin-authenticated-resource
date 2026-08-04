import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { rejection } from './errors.mts'

const create = vi.fn()
const updateOne = vi.fn()
const esisteImprenditore = vi.fn()

// No `deleteOne`: since `azienda` gained its `deleted` column the delete is a `$set` like every other
// one on this tier, and leaving the method on the mock would let a rewrite go back to a hard delete
// without a single test noticing.
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda', () => ({
	Azienda: { create, updateOne }
}))

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore', () => ({
	Imprenditore: { exists: esisteImprenditore }
}))

const { chiaveDuplicata } = await import('../src/lib/mongo/chiaveDuplicata.mts')
const { funAziendaAdd } = await import('../src/lib/azienda/funAziendaAdd.mts')
const { funAziendaDelete } = await import('../src/lib/azienda/funAziendaDelete.mts')
const { funAziendaUpdate } = await import('../src/lib/azienda/funAziendaUpdate.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439014')
const idImprenditore = new Types.ObjectId('507f1f77bcf86cd799439013')

const dati = {
	ragionesociale: 'Pizzeria da Mario S.r.l.',
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
} as never

const duplicato = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })

/** The chain ends in `.exec()`, as everywhere else on this tier. */
function mockUpdateMatched(matchedCount: number) {
	updateOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ matchedCount, modifiedCount: 0 }) })
}

describe('chiaveDuplicata', () => {
	// Duck-typed on `code` rather than `instanceof MongoServerError`: a second copy of the mongodb
	// driver under a transitive dependency makes the instanceof false while the code stays 11000, and
	// the failure mode of getting that wrong is a duplicate key surfacing as a 500. It lives with the
	// azienda tests because `azienda` is the only collection left carrying a unique index — 20260803000100
	// dropped `piva_unique` and `pec_unique` from `puntoVendita` and rebuilt them here.
	it.each([
		['the driver’s duplicate-key error', duplicato(), true],
		['a plain object carrying the code', { code: 11000 }, true],
		['another driver error', Object.assign(new Error('rete'), { code: 'ECONNRESET' }), false],
		['a different numeric code', { code: 121 }, false],
		['an error with no code at all', new Error('boom'), false],
		['an empty object', {}, false],
		['null', null, false],
		['undefined', undefined, false],
		['a string', 'E11000 duplicate key error', false],
		['a number', 11000, false]
	])('reads %s as %s', (_desc, valore, atteso) => {
		expect(chiaveDuplicata(valore)).toBe(atteso)
	})
})

describe('funAziendaAdd', () => {
	beforeEach(() => {
		create.mockReset().mockResolvedValue({})
		esisteImprenditore.mockReset().mockResolvedValue({ _id: idImprenditore })
	})

	it('writes the company under the owner, minting the id', async () => {
		await expect(funAziendaAdd(idImprenditore, dati)).resolves.toBeUndefined()

		const [doc] = create.mock.calls[0]
		expect(doc._id).toBeInstanceOf(Types.ObjectId)
		expect(doc.idImprenditore).toBe(idImprenditore)
		expect(Object.keys(doc).sort()).toEqual([
			'_id',
			'amministratore',
			'cf',
			'idImprenditore',
			'indirizzo',
			'pec',
			'piva',
			'ragionesociale',
			'referente',
			'univoco',
			'visura'
		])
	})

	// Every marketplace-common model declares `_id` without a default, which switches auto-generation
	// off, so an id minted once at module load would work exactly once.
	it('mints a distinct id for every company', async () => {
		await funAziendaAdd(idImprenditore, dati)
		await funAziendaAdd(idImprenditore, dati)

		expect(create.mock.calls[0][0]._id).not.toEqual(create.mock.calls[1][0]._id)
	})

	// ⚠️ The check that stops an orphan: `imprenditoreAziende` lists by owner, so a company under an
	// imprenditore that does not exist is reachable only through the same wrong id that created it.
	it('refuses to create a company under an imprenditore that does not exist', async () => {
		esisteImprenditore.mockResolvedValueOnce(null)

		expect(await rejection(funAziendaAdd(idImprenditore, dati))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'imprenditore non trovato'
		})
		expect(create).not.toHaveBeenCalled()
	})

	// Soft-deleted counts as absent, and `trusted()` is what keeps the `$exists` clause from being
	// rewritten by mongoose's global sanitizeFilter into a literal comparison that matches nothing.
	it('looks the owner up by id, excluding the soft-deleted', async () => {
		await funAziendaAdd(idImprenditore, dati)

		const [filtro] = esisteImprenditore.mock.calls[0]
		expect(filtro._id).toBe(idImprenditore)
		expect(filtro.deleted.$exists).toBe(false)
	})

	// Both `piva_unique` and `pec_unique` can fire, the driver's error does not say which, and guessing
	// would send the operator to the wrong box.
	it('turns a unique-index violation into a 409 naming both candidates', async () => {
		create.mockRejectedValueOnce(duplicato())

		expect(await rejection(funAziendaAdd(idImprenditore, dati))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'partita IVA o PEC già registrate da un’altra azienda'
		})
	})

	it('rethrows any other driver error untouched', async () => {
		const guasto = Object.assign(new Error('validazione fallita'), { code: 121 })
		create.mockRejectedValueOnce(guasto)

		await expect(funAziendaAdd(idImprenditore, dati)).rejects.toBe(guasto)
	})
})

describe('funAziendaUpdate', () => {
	beforeEach(() => updateOne.mockReset())

	it('replaces the company’s fields in a single write', async () => {
		mockUpdateMatched(1)

		await expect(funAziendaUpdate(_id, dati)).resolves.toBeUndefined()

		// One `$set`, and `idImprenditore` is not in it — it is not in `IAziendaValidata` either, which is
		// what keeps a company from being reassigned by editing its card.
		expect(updateOne).toHaveBeenCalledExactlyOnceWith({ _id }, { $set: dati })
	})

	it('turns a unique-index violation into a 409 naming both candidates', async () => {
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(duplicato()) })

		expect(await rejection(funAziendaUpdate(_id, dati))).toEqual({
			message: 'Conflict',
			http: { status: 409 },
			description: 'partita IVA o PEC già registrate da un’altra azienda'
		})
	})

	it('rethrows any other driver error untouched', async () => {
		const guasto = Object.assign(new Error('validazione fallita'), { code: 121 })
		updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(guasto) })

		await expect(funAziendaUpdate(_id, dati)).rejects.toBe(guasto)
	})

	// Saving a card unchanged still matched, and that is a success — the convention every write on this
	// tier follows.
	it('accepts a write that changed nothing, as long as the company exists', async () => {
		mockUpdateMatched(1)

		await expect(funAziendaUpdate(_id, dati)).resolves.toBeUndefined()
	})

	it('raises a 404 when no azienda carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funAziendaUpdate(_id, dati))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'azienda non trovata'
		})
	})
})

describe('funAziendaDelete', () => {
	beforeEach(() => updateOne.mockReset())

	// A soft delete, like every other delete on this tier since `azienda` gained the column: the row stays
	// and `deleted` gets a numeric timestamp, cast to the schema's Date path by mongoose. Nothing else is
	// touched — `$set` names one field and the filter is the id alone.
	it('stamps deleted and touches nothing else', async () => {
		mockUpdateMatched(1)

		await expect(funAziendaDelete(_id)).resolves.toBeUndefined()

		const [filter, update] = updateOne.mock.calls[0]
		expect(updateOne).toHaveBeenCalledOnce()
		expect(filter).toEqual({ _id })
		expect(Object.keys(update)).toEqual(['$set'])
		expect(Object.keys(update.$set)).toEqual(['deleted'])
		expect(typeof update.$set.deleted).toBe('number')
	})

	// `matchedCount`, not `modifiedCount`: 0 matched is a stale Elimina button naming a row already gone,
	// while re-deleting one that is already stamped still matched and is the state the operator asked for.
	it('raises a 404 when no azienda carries that id', async () => {
		mockUpdateMatched(0)

		expect(await rejection(funAziendaDelete(_id))).toEqual({
			message: 'Oops',
			http: { status: 404 },
			description: 'azienda non trovata'
		})
	})
})
