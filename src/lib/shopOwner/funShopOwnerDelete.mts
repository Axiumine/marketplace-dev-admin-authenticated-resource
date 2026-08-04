import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
import { Types } from 'mongoose'

/**
 *
 * @param _id
 * @returns {Promise<any>}
 */

/**
 * Set shopOwner as deleted
 * @param _id
 */
export async function funShopOwnerDelete(_id: Types.ObjectId) {
	const ret = await ShopOwner.updateOne(
		{ _id: _id },
		{
			$set: { deleted: Date.now() },
			$unset: { waitApprov: 1 }
		}
	).exec()
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}
}
