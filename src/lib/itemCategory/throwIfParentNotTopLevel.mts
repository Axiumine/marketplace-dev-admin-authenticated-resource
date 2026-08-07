import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ItemCategory } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ItemCategory'
import { trusted, Types } from 'mongoose'

/**
 * ⚠️ **The two-level depth cap. This function is the entire enforcement of it on the platform.**
 *
 * A row with no `idParent` is a category; a row whose `idParent` names a category is a subcategory; a
 * row whose `idParent` names a *subcategory* is the thing the taxonomy must not contain. The
 * collection validator cannot say so — the parent's own `idParent` lives in a different document and a
 * MongoDB validator sees exactly one at a time — so the rule lives here, and every write path that
 * accepts an `idParent` has to call it. Today that is `itemCategoryAdd` and `itemCategoryUpdate`; a
 * third one inherits the obligation.
 *
 * Three failures, three different answers:
 *
 *   - the parent does not exist, or is soft-deleted → 404. MongoDB has no foreign keys, so nothing
 *     else would catch it, and a subcategory under an invisible parent is unreachable from
 *     `/category/:slug/:subSlug`.
 *   - the parent is itself a subcategory → 400. The operator asked for a third level.
 *   - the parent is the row being edited → 400. A category cannot be its own parent; the cheap way to
 *     make a cycle, and the only one two levels leave room for.
 *
 * `_id` is the row being written, absent on the create path. It only exists to catch the self-parent
 * case, which on create is impossible: the id is minted after this runs — and needs no branch of its
 * own, since `String(undefined)` is `'undefined'` and never equals a 24-character hex.
 *
 * Compared as strings rather than with `.equals()`: `idParent` is cast from a GraphQLID while `_id`
 * comes from the resolver's own argument, so the two are equal in value while being different objects.
 */
export async function throwIfParentNotTopLevel(idParent: Types.ObjectId, _id?: Types.ObjectId) {
	if (String(_id) === String(idParent)) {
		throwErrorWrongUserInput('itemCategory.idParent: a category cannot be its own parent')
	}

	const parent = await ItemCategory.findOne({ _id: idParent, deleted: trusted({ $exists: false }) }, { idParent: 1 }).lean()

	if (parent === null) throwNotFoundError('parent category not found')

	if (parent.idParent !== undefined) {
		throwErrorWrongUserInput('itemCategory.idParent: the taxonomy is two levels deep — a subcategory cannot have children')
	}
}
