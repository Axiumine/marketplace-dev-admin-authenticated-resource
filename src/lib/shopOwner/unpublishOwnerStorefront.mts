import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { ClientSession, trusted, Types } from 'mongoose'

/**
 * Takes an inactive shop owner's whole storefront off air: every company they hold, and every item
 * filed under one of those companies (ADR-045 and its Amendment).
 *
 * ⚠️ **This hangs off the owner becoming inactive, not off the tier that made them inactive.** Suspension
 * and closure both call it, and so must the ShopOwner-tier self-service closure when that is built — a
 * self-closure that skips the cascade is the same defect as an admin closure that skips it. The
 * platform owner's ruling names both hands: *"so disable a shop owner, by shop owner or by admin,
 * unpublish companies and items"*.
 *
 * ⚠️ **Nothing here has an inverse, and building one is a direct contradiction of the ruling.** Releasing
 * a suspension and restoring a closed account both write to the `shopOwner` document alone; the shops and
 * the catalogue stay dark until the owner republishes them by hand. Restoring what was published before
 * would mean remembering it, which is the option ADR-045 rejected. The owner's remedy is
 * `itemsUpdatePublished` on the ShopOwner tier — select-all, one call — not a helpful symmetry here.
 *
 * ⚠️ **Both writes belong in the caller's transaction, which is why `session` is required rather than
 * optional.** A crash between the `shopOwner` stamp and these two leaves an inactive owner with a live
 * storefront, which is the single failure ADR-045 exists to prevent. Passing `null` would type-check and
 * would silently reopen that window.
 *
 * **The item hop cannot be shortened.** `item` carries no `idShopOwner` — ownership is transitive through
 * `idCompany`, exactly as `throwIfShopOwnerDontOwnItem` documents — so the company ids have to be read
 * before the items can be named. They come from one projection over a set bounded by how many shops one
 * person runs.
 *
 * **No `deleted` clause on the company read, and no empty-list branch.** A retired company is invisible
 * either way and unpublishing it costs nothing, while a filter that skipped it would leave its items
 * addressable if it were ever restored. An owner with no companies produces `$in: []`, which matches
 * nothing and writes nothing — a `length > 0` guard would buy an extra branch for a case the driver
 * already handles.
 *
 * `{ idShopOwner }` and `{ _id }` carry no `$`-keyed value and need no `trusted()`; the `$in` does, because
 * `sanitizeFilter` is global and would strip it.
 */
export async function unpublishOwnerStorefront(idShopOwner: Types.ObjectId, session: ClientSession) {
	const companies = await Company.find({ idShopOwner: idShopOwner }, '_id').session(session).lean<{ _id: Types.ObjectId }[]>()

	await Company.updateMany({ idShopOwner: idShopOwner }, { $set: { published: false } })
		.session(session)
		.exec()

	await Item.updateMany({ idCompany: trusted({ $in: companies.map((company) => company._id) }) }, { $set: { published: false } })
		.session(session)
		.exec()
}
