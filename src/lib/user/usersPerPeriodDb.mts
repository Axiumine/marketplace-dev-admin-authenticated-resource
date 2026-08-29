import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import registeredAtSeriesDb, { IPerPeriod, StatsPeriod } from '@lib/stats/registeredAtSeriesDb.mjs'

/**
 * The customers-over-time series behind the admin's customers chart — `shopOwnersPerPeriodDb` with
 * `User` in place of `ShopOwner`, and nothing else.
 *
 * E19 §6 question 2, answered by the platform owner on 2026-08-29. The question had been open since the
 * customers table was built, and it was never blocked on anything: `registeredAt` is clear on `user`, so
 * ADR-029 has nothing to say about this query the way it has about the table's missing `search`.
 * `20260829000200` in marketplace-db-setup gives it the `registeredAt_series` index `shopOwner` has had
 * since `20260301000100`.
 *
 * ⚠️ **Unfiltered, so the points sum to `usersStatsDb`'s Total.** A closed or suspended customer is still
 * someone who registered, and the chart says when people registered — not how many are usable today.
 */

export type UsersPeriod = StatsPeriod

export type IUsersPerPeriod = IPerPeriod

export default async function usersPerPeriodDb(period: UsersPeriod): Promise<IUsersPerPeriod> {
	return await registeredAtSeriesDb(User, period)
}
