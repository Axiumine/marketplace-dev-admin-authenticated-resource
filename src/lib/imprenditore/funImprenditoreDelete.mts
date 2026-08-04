import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { Types } from 'mongoose'

/**
 *
 * @param _id
 * @returns {Promise<any>}
 */

/**
 * Set imprenditore as deleted
 * @param _id
 */
export async function funImprenditoreDelete(_id: Types.ObjectId) {
	const ret = await Imprenditore.updateOne(
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
