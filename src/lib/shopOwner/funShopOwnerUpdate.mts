import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { IShopOwnerPersonalData } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IShopOwnerPersonalData'
import { Types } from 'mongoose'

/**
 * Update shopOwner personalData
 * @param _id
 * @param personalData
 */
export async function funShopOwnerUpdate(_id: Types.ObjectId, personalData: IShopOwnerPersonalData) {
	const ret = await ShopOwner.updateOne(
		{ _id: _id },
		{
			$set: { personalData }
		}
	).exec()
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}
}
