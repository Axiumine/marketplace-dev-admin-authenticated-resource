import { IRedisDataAdmin } from '@axiumine/marketplace-common/others/Redis/IRedisDataAdmin'
import { IRedisDataAdminForNode } from '@axiumine/marketplace-common/others/Redis/IRedisDataAdminForNode'
import { Types } from 'mongoose'

export function makeAuthCtx(redData: IRedisDataAdmin): IRedisDataAdminForNode {
	return {
		_id: new Types.ObjectId(redData._id),
		email: redData.email
	}
}
