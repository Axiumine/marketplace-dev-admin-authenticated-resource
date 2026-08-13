import { GraphQLObjectType } from 'graphql'

import { companyItems } from './queries/companyItems.mjs'
import { infoAdminAfterLogin } from './queries/infoAdminAfterLogin.mjs'
import { itemCategories } from './queries/itemCategories.mjs'
import { keygripStatus } from './queries/keygripStatus.mjs'
import { reuseEvents } from './queries/reuseEvents.mjs'
import { sessions } from './queries/sessions.mjs'
import { shopOwnerById } from './queries/shopOwnerById.mjs'
import { shopOwnerCompanies } from './queries/shopOwnerCompanies.mjs'
import { shopOwnersActiveTbl } from './queries/shopOwnersActiveTbl.mjs'
import { shopOwnersPerPeriod } from './queries/shopOwnersPerPeriod.mjs'
import { shopOwnersStats } from './queries/shopOwnersStats.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		infoAdminAfterLogin,
		shopOwnersActiveTbl,
		shopOwnersStats,
		shopOwnersPerPeriod,
		shopOwnerById,
		shopOwnerCompanies,
		companyItems,
		itemCategories,
		keygripStatus,
		sessions,
		reuseEvents
	}
})

export default QueriesApi
