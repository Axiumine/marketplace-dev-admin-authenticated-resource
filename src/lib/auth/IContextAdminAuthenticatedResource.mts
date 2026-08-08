import { TCommonHeaders } from '@axiumine/koa-utils/graphQL/schema/context/TCommonHeaders'
import { IRedisDataAdminForNode } from '@axiumine/marketplace-common/others/Redis/IRedisDataAdminForNode'
import { IncomingHttpHeaders } from 'http'

type IStateApi = {
	user: IRedisDataAdminForNode
}
export type IContextAdminAuthenticatedResource = {
	state: IStateApi
	request: {
		header?: TCommonHeaders & IncomingHttpHeaders
	}
}
export {}
