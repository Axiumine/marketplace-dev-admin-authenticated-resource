import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { chiaveDuplicata } from '@lib/mongo/chiaveDuplicata.mjs'
import { IAziendaValidata } from '@lib/validate/validaAzienda.mjs'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { trusted, Types } from 'mongoose'

/**
 * Creates one company under an existing imprenditore.
 *
 * The owner is checked first: `idImprenditore` reaches this from the URL of the operator's detail page,
 * `azienda` carries no foreign-key constraint — MongoDB has none — and the only read path is
 * `imprenditoreAziende`, which lists by owner. An id that names nothing therefore inserts happily and
 * produces a row reachable only through the same wrong id that created it. A soft-deleted imprenditore
 * counts as absent on the same grounds.
 *
 * `_id` is minted here rather than left to mongoose: every model in marketplace-common declares `_id`
 * without a default, which switches auto-generation off, so `create()` on a document without one throws
 * before it reaches MongoDB.
 *
 * The duplicate-key message names both unique indexes — `piva_unique` and `pec_unique`, both globally
 * unique — because the driver's error does not say which one it tripped on and guessing would send the
 * operator to the wrong box. These are the two indexes that used to sit on `puntoVendita.azienda.*` and
 * made a company's second shop impossible; they are the same rule, applied where it is true.
 *
 * Neither carries a `partialFilterExpression`, so a **deleted** company still occupies its partita IVA
 * and this rejects the same one being registered again. Deliberate, and the same shape as
 * `imprenditore.login.email_unique`: a partial index would let two rows hold one partita IVA the moment
 * a deleted company were restored, and there is no restore flow to make that safe.
 */
export async function funAziendaAdd(idImprenditore: Types.ObjectId, dati: IAziendaValidata) {
	const proprietario = await Imprenditore.exists({ _id: idImprenditore, deleted: trusted({ $exists: false }) })

	if (proprietario === null) throwNotFoundError('imprenditore non trovato')

	try {
		await Azienda.create({ _id: new Types.ObjectId(), idImprenditore, ...dati })
	} catch (e) {
		if (chiaveDuplicata(e)) throwAlreadyTakenError('partita IVA o PEC già registrate da un’altra azienda')

		throw e
	}
}
