import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { trusted, Types } from 'mongoose'

/**
 * The other half of the depth cap: a category that already has subcategories cannot be given a parent.
 *
 * `throwIfParentNotTopLevel` looks upwards — is the row I am being filed under a top-level one? This
 * looks downwards, and without it the cap has a hole one save wide: take a top-level category with
 * three subcategories under it, hand it an `idParent`, and every one of those three is now three levels
 * deep, each of them individually valid and none of them written by this update.
 *
 * Only `itemCategoryUpdate` needs it. On the create path the row has no children yet, by construction.
 *
 * Deleted children do not count. They are invisible to every read path, so they cannot be the third
 * level of anything a customer sees, and refusing over them would make a category permanently
 * unmovable for a subcategory somebody retired a year ago.
 */
export async function throwIfHasChildren(_id: Types.ObjectId) {
	const children = await ItemCategory.countDocuments({ idParent: _id, deleted: trusted({ $exists: false }) }).lean()

	if (children > 0) {
		throwErrorWrongUserInput('itemCategory.idParent: this category has subcategories — move or remove them first')
	}
}
