import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { IAnagraficaImprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IAnagraficaImprenditore'
import { Types } from 'mongoose'

/**
 * Update imprenditore anagrafica
 * @param _id
 * @param anagrafica
 */
export async function funImprenditoreUpdate(_id: Types.ObjectId, anagrafica: IAnagraficaImprenditore) {
	const ret = await Imprenditore.updateOne(
		{ _id: _id },
		{
			$set: { anagrafica }
		}
	).exec()
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}
}
