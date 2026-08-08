import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'

export default async function shopOwnersStatsDb() {
	return ShopOwner.countDocuments()
}
