import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import registeredAtSeriesDb, { IPerPeriod, StatsPeriod } from '@lib/stats/registeredAtSeriesDb.mjs'

/**
 * The shopOwners-over-time series behind the operator's stats chart.
 *
 * ⚠️ **Everything that decides anything lives in `@lib/stats/registeredAtSeriesDb.mjs`** — the three
 * ranges, the bucket widths, the UTC boundary arithmetic and the gap filling — and this file names the
 * collection. `usersPerPeriodDb` is its twin; read the shared file's header for why there is one copy
 * of the maths and not two.
 *
 * The two names below are aliases of the shared ones and exist so the caller keeps reading in terms of
 * the thing it is charting. They are not distinct types and nothing may make them distinct: a shopOwner
 * series and a customer series are the same shape by construction.
 */

export type ShopOwnersPeriod = StatsPeriod

export type IShopOwnersPerPeriod = IPerPeriod

export default async function shopOwnersPerPeriodDb(period: ShopOwnersPeriod): Promise<IShopOwnersPerPeriod> {
	return await registeredAtSeriesDb(ShopOwner, period)
}
