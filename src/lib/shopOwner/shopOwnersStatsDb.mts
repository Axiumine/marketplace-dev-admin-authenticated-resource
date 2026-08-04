import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'

export default async function shopOwnersStatsDb() {
	return ShopOwner.countDocuments()
}
