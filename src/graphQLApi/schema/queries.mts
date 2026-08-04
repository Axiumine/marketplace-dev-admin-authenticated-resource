import { GraphQLObjectType } from 'graphql'

import { imprenditoreAziende } from './queries/imprenditoreAziende.mjs'
import { imprenditoreById } from './queries/imprenditoreById.mjs'
import { imprenditoriAttiviTbl } from './queries/imprenditoriAttiviTbl.mjs'
import { imprenditoriPerPeriodo } from './queries/imprenditoriPerPeriodo.mjs'
import { imprenditoriStats } from './queries/imprenditoriStats.mjs'
import { infoAdminAfterLogin } from './queries/infoAdminAfterLogin.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		infoAdminAfterLogin,
		imprenditoriAttiviTbl,
		imprenditoriStats,
		imprenditoriPerPeriodo,
		imprenditoreById,
		imprenditoreAziende
	}
})

export default QueriesApi
