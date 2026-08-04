import { throwAlreadyTakenError } from '@axiumine/koa-utils/graphQL/throw/throwAlreadyTakenError'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { chiaveDuplicata } from '@lib/mongo/chiaveDuplicata.mjs'
import { IAziendaValidata } from '@lib/validate/validaAzienda.mjs'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { Types } from 'mongoose'

/**
 * Replaces a company's editable fields in one write.
 *
 * The whole card is one form and saves once, so this is one `$set` — and a single-document update is
 * atomic, unlike the nine round trips a per-field mutation would need.
 *
 * `indirizzo` is written **whole**, which is why the caller hands over an already-normalised object:
 * `$set: { indirizzo }` replaces the entire sub-document, and `validaAzienda` is what guarantees no
 * member of it arrives as a `null` the collection validator would reject.
 *
 * `idImprenditore` is not in `IAziendaValidata` and so cannot be touched here. That is the point:
 * reassigning a company to a different owner is not a flow anybody has asked for.
 *
 * `matchedCount`, not `modifiedCount`: saving a card unchanged still matched, and that is a success —
 * the same convention as every other write on this tier.
 *
 * No `deleted` filter, like every other write on this tier: the filters sit on the read paths, which is
 * what keeps a soft-deleted company out of the Aziende box. There is no page left that can reach this
 * with a deleted id, and `deleted` is not in `IAziendaValidata`, so a save cannot revive one either.
 */
export async function funAziendaUpdate(_id: Types.ObjectId, dati: IAziendaValidata) {
	let ret

	try {
		ret = await Azienda.updateOne({ _id: _id }, { $set: dati }).exec()
	} catch (e) {
		if (chiaveDuplicata(e)) throwAlreadyTakenError('partita IVA o PEC già registrate da un’altra azienda')

		throw e
	}

	if (ret.matchedCount !== 1) throwNotFoundError('azienda non trovata')
}
