import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { ClientSession, trusted, Types } from 'mongoose'

/**
 * The other half of the depth cap: a category that already has subcategories cannot be given a parent.
 *
 * `throwIfParentNotTopLevel` looks upwards — is the category I am being filed under a top-level one? This
 * looks downwards, and without it the cap has a hole one save wide: take a top-level category with
 * three subcategories under it, hand it an `idParent`, and every one of those three is now three levels
 * deep, each of them individually valid and none of them written by this update.
 *
 * Only `itemCategoryUpdate` needs it. On the create path the category has no children yet, by construction.
 *
 * Deleted children do not count. They are invisible to every read path, so they cannot be the third
 * level of anything a customer sees, and refusing over them would make a category permanently
 * unmovable for a subcategory somebody retired a year ago.
 *
 * This count needs no `$inc` of its own to be safe against a child appearing between it and the update
 * it guards, and the reason is worth stating: the racing `itemCategoryAdd` writes the parent it files
 * under — `throwIfParentNotTopLevel` sees to that — while this update writes that same document itself.
 * The two collide on it, one is aborted with a `WriteConflict` and retried, and the retry counts the
 * child that appeared. Reading in the caller's session is all this has to do.
 */
export async function throwIfHasChildren(_id: Types.ObjectId, session: ClientSession) {
	const children = await ItemCategory.countDocuments({ idParent: _id, deleted: trusted({ $exists: false }) })
		.session(session)
		.lean()

	if (children > 0) {
		throwErrorWrongUserInput('itemCategory.idParent: this category has subcategories — move or remove them first')
	}
}
