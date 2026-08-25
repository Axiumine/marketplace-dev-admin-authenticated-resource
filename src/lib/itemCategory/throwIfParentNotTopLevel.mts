import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { ClientSession, trusted, Types } from 'mongoose'

/**
 * ⚠️ **The two-level depth cap. This function is the entire enforcement of it on the platform.**
 *
 * A document with no `idParent` is a category; one whose `idParent` names a category is a
 * subcategory; one whose `idParent` names a *subcategory* is the thing the taxonomy must not
 * contain. The
 * collection validator cannot say so — the parent's own `idParent` lives in a different document and a
 * MongoDB validator sees exactly one at a time — so the rule lives here, and every write path that
 * accepts an `idParent` has to call it. Today that is `itemCategoryAdd` and `itemCategoryUpdate`; a
 * third one inherits the obligation.
 *
 * Three failures, three different answers:
 *
 *   - the parent does not exist, or is soft-deleted → 404. Nothing else would catch it, and a
 *     subcategory under an invisible parent is unreachable from `/category/:slug/:subSlug`.
 *   - the parent is itself a subcategory → 400. The operator asked for a third level.
 *   - the parent is the category being edited → 400. A category cannot be its own parent; the cheap way to
 *     make a cycle, and the only one two levels leave room for.
 *
 * ⚠️ **This reads the parent with a write, and the `$inc` is the whole point of it.** The check and the
 * write it guards are two operations on two *different* documents, so running them in a transaction is
 * not enough on its own: MongoDB transactions are snapshot-isolated, not serialisable, and snapshot
 * isolation permits write skew — read the parent, have somebody else retire it, write the child, and
 * both transactions commit having each seen a consistent snapshot. Touching the parent turns the read
 * into a write on the very document the racing `itemCategoryDel` stamps, so the two now collide on one
 * document and the server aborts one of them with a `WriteConflict`. That error carries the
 * `TransientTransactionError` label, so `withTransaction` retries the loser, which re-reads the parent,
 * finds it retired and answers the 404 above. `__v` is the field to touch because nothing reads it:
 * mongoose maintains it for `save()` on documents with arrays, this collection is never written that
 * way, and the validator already declares it `bsonType: 'int'`.
 *
 * The cost is contention: two subcategories being added under one parent at the same instant now
 * serialise on it. On a taxonomy one operator tier writes, that is a retry nobody will observe.
 *
 * `_id` is the document being written, absent on the create path. It only exists to catch the self-parent
 * case, which on create is impossible: the id is minted after this runs — and needs no branch of its
 * own, since `String(undefined)` is `'undefined'` and never equals a 24-character hex.
 *
 * Compared as strings rather than with `.equals()`: `idParent` is cast from a GraphQLID while `_id`
 * comes from the resolver's own argument, so the two are equal in value while being different objects.
 */
export async function throwIfParentNotTopLevel(idParent: Types.ObjectId, session: ClientSession, _id?: Types.ObjectId) {
	if (String(_id) === String(idParent)) {
		throwErrorWrongUserInput('itemCategory.idParent: a category cannot be its own parent')
	}

	const parent = await ItemCategory.findOneAndUpdate(
		{ _id: idParent, deleted: trusted({ $exists: false }) },
		{ $inc: { __v: 1 } },
		{ projection: { idParent: 1 } }
	)
		.session(session)
		.lean()

	if (parent === null) throwNotFoundError('parent category not found')

	if (parent.idParent !== undefined) {
		throwErrorWrongUserInput('itemCategory.idParent: the taxonomy is two levels deep — a subcategory cannot have children')
	}
}
