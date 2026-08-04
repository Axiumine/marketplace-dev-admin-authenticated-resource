import { GraphQLItemCategory } from '@ptypes/GraphQLItemCategory.mjs'
import { ItemCategory } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ItemCategory'
import { GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted } from 'mongoose'

/**
 * The whole taxonomy, flat, for the operator's category screen.
 *
 * No args and no paging: the list is bounded by hand — an operator writes it, nobody else can — and the
 * screen needs every row at once to render parents with their children under them. Flat rather than
 * nested because the depth cap is two, so the client groups by `idParent` in one pass.
 *
 * Sorted by `position` then `_id`: `position` is the operator's chosen order and is not unique, so
 * without the `_id` tiebreak two categories sharing a position swap places between calls and the screen
 * reorders itself for no reason.
 */
export const itemCategories = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLItemCategory))),
	description: 'Get all the item categories',
	async resolve() {
		return ItemCategory.find({ deleted: trusted({ $exists: false }) })
			.sort({ position: 1, _id: 1 })
			.lean()
	}
}
