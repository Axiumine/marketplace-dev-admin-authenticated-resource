import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'

export default async function imprenditoriStatsDb() {
	return Imprenditore.countDocuments()
}
