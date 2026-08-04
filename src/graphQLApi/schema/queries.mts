import { GraphQLObjectType } from 'graphql'

import { shopOwnerCompanies } from './queries/shopOwnerCompanies.mjs'
import { shopOwnerById } from './queries/shopOwnerById.mjs'
import { shopOwnersActiveTbl } from './queries/shopOwnersActiveTbl.mjs'
import { shopOwnersPerPeriod } from './queries/shopOwnersPerPeriod.mjs'
import { shopOwnersStats } from './queries/shopOwnersStats.mjs'
import { infoAdminAfterLogin } from './queries/infoAdminAfterLogin.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		infoAdminAfterLogin,
		shopOwnersActiveTbl,
		shopOwnersStats,
		shopOwnersPerPeriod,
		shopOwnerById,
		shopOwnerCompanies
	}
})

export default QueriesApi
