import imprenditoriAttiviTblDb, {
	IImprenditoriAttiviTblArgs,
	IMPRENDITORI_TBL_DEFAULT_LIMIT
} from '@lib/imprenditore/imprenditoriAttiviTblDb.mjs'
import { GraphQLImprenditoriAttiviTblPage } from '@ptypes/GraphQLImprenditoriAttiviTblPage.mjs'
import { GraphQLImprenditoriTblSortField, GraphQLSortDirection } from '@ptypes/GraphQLImprenditoriTblSort.mjs'
import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'

export const imprenditoriAttiviTbl = {
	type: new GraphQLNonNull(GraphQLImprenditoriAttiviTblPage),
	description: 'Get imprenditori per tabella',
	// NonNull + defaultValue rather than nullable: the caller may omit any of these, but the resolver
	// is never handed an explicit `null` it would have to re-default. The whole paging contract stays
	// readable from the schema — including, through the enums, the only four columns that sort.
	args: {
		offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
		limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: IMPRENDITORI_TBL_DEFAULT_LIMIT },
		// The one nullable argument: "not searching" is a real state of the table, and a distinct one
		// from searching for the empty string.
		search: { type: GraphQLString },
		sortBy: { type: new GraphQLNonNull(GraphQLImprenditoriTblSortField), defaultValue: 'ISCRIZIONE' },
		sortDir: { type: new GraphQLNonNull(GraphQLSortDirection), defaultValue: 'DESC' }
	},
	async resolve(_: unknown, args: IImprenditoriAttiviTblArgs) {
		return await imprenditoriAttiviTblDb(args)
	}
}
