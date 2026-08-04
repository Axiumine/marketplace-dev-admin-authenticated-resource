import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { Azienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Azienda'
import { Types } from 'mongoose'

/**
 * Marks one company deleted.
 *
 * **A soft delete, like every other delete on this tier.** The row stays and gains a `deleted` instant;
 * every read path filters it out with `deleted: { $exists: false }`, so the company disappears from the
 * operator's page without the document going anywhere.
 *
 * The consequence to know about: `piva_unique` and `pec_unique` are plain global unique indexes with no
 * `partialFilterExpression`, so a deleted company keeps its partita IVA occupied and the same one
 * cannot be registered again. That is deliberate — it matches `imprenditore.login.email_unique`, and a
 * partial index would let two rows carry the same partita IVA the moment one of them is restored.
 *
 * Until 2026-08-04 this refused while any live `puntoVendita` still pointed at the row — the collection
 * carried `idAzienda` as its own foreign key. `puntoVendita` is gone along with every reference to it,
 * so there is nothing left to check before the row is stamped.
 *
 * `Date.now()`, a number, cast to the schema's `Date` path by mongoose on the way out. The write carries
 * no `deleted` filter of its own: a re-delete stamps a fresh instant and is the state the operator asked
 * for, while the row is unreachable from any page anyway.
 *
 * `matchedCount`, not `modifiedCount`, and a 404: 0 matched means no such company, which the operator
 * can act on. Same convention as every other write on this tier.
 */
export async function funAziendaDelete(_id: Types.ObjectId) {
	const ret = await Azienda.updateOne({ _id: _id }, { $set: { deleted: Date.now() } }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('azienda non trovata')
}
