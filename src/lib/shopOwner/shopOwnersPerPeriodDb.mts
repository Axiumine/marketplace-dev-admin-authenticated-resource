import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
import { PipelineStage } from 'mongoose'

/**
 * The shopOwners-over-time series behind the operator's stats chart.
 *
 * Three ranges, one shape. The caller picks how far back to look; the server picks how finely to
 * bucket, because that is a property of the range and not of the client — a day-by-day series over
 * the whole life of the platform is thousands of points nobody can read, and a month-by-month series
 * over the last thirty days is one bar.
 *
 * ⚠️ **Unfiltered, exactly like `shopOwnersStatsDb`.** No `deleted` / `disabled` exclusion, so the
 * points sum to the "Totali" row the chart sits under. Filtering here and not there would put two
 * numbers that look like the same number on the same screen, disagreeing.
 *
 * ⚠️ **Everything is bucketed in UTC**, both in the `$dateToString` below and in the gap filling. Rome
 * is UTC+1/+2, so an shopOwner registered at 00:30 local lands in the previous day's bucket. That
 * is a deliberate trade: bucketing in Europe/Rome means every boundary — the range start, the day
 * steps, the month steps — has to be computed in a zone with two DST transitions a year, and a
 * one-to-two-hour skew on a registration timestamp is invisible at this chart's resolution. If the
 * chart ever gains an hour-of-day axis, this is the decision to revisit first.
 */

/**
 * One row per range the GraphQL enum offers, holding all three facts about it together.
 *
 * `granularity` and `format` are NOT asked for by the client and not stored apart from `months`,
 * because they are consequences of the range: a caller able to request day buckets over `ALL`
 * would be asking the database for one group per day since the platform opened and the browser to
 * draw them. Keeping the three in one row is also what stops the bucket width and the date format
 * from drifting apart — they describe the same decision and there is one place to change it.
 */
const RANGES = {
	ALL: { months: null, granularity: 'MONTH', format: '%Y-%m-01' },
	THREE_MONTHS: { months: 3, granularity: 'DAY', format: '%Y-%m-%d' },
	ONE_MONTH: { months: 1, granularity: 'DAY', format: '%Y-%m-%d' }
} as const

export type ShopOwnersPeriod = keyof typeof RANGES

export type PeriodGranularity = (typeof RANGES)[ShopOwnersPeriod]['granularity']

/**
 * `date` is a `YYYY-MM-DD` string in **both** granularities — a month bucket is stamped with its own
 * first day rather than truncated to `YYYY-MM`. One format means the client has one parse path, and
 * `granularity` tells it how to label the axis. The alternative, a string whose meaning depends on
 * its length, invites exactly the off-by-one nobody notices until December.
 */
export interface IShopOwnersPerPeriodPoint {
	date: string
	total: number
}

export interface IShopOwnersPerPeriod {
	granularity: PeriodGranularity
	points: IShopOwnersPerPeriodPoint[]
}

/**
 * 24 × 60 × 60 × 1000, spelled as a literal.
 *
 * Written out because the product form has an operator to mutate and the literal does not: turning
 * one `*` into `/` makes the step a fraction of a millisecond, which does not fail a test — it turns
 * the loop in `dayBuckets` into ~10^12 iterations and kills the worker process, so the mutant is
 * reported as a runtime error and Stryker retries the whole run twice before giving up on it.
 */
const MS_PER_DAY = 86_400_000

/** `YYYY-MM-DD` from a UTC timestamp. `toISOString` is UTC by definition, so no zone maths here. */
function toBucketKey(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The inverse of `toBucketKey`. No time part is appended and none is needed: the date-only form of
 * ISO 8601 is defined to be UTC, while `YYYY-MM-DDTHH:mm:ss` without a zone is defined to be LOCAL.
 * Adding `T00:00:00` and forgetting the `Z` is the one way to get this wrong, so nothing is added.
 */
function fromBucketKey(key: string): number {
	return Date.parse(key)
}

/** Midnight UTC of the day `date` falls on. The upper end of every range, and the day step's base. */
function startOfDayUTC(date: Date): number {
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/** Midnight UTC of the first of the month `ms` falls in. The month step's base. */
function startOfMonthUTC(ms: number): number {
	const d = new Date(ms)

	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/**
 * The same day-of-month `months` earlier, **clamped to that month's length**.
 *
 * `Date.UTC(y, m - 1, 31)` is not "a month before the 31st" — it overflows into the next month, so
 * asking for one month before 31 March would answer 3 March and quietly return a 28-day range
 * labelled as a month. Clamping answers 28 February instead, which is the only reading of "a month
 * ago" a calendar supports.
 */
function subMonthsUTC(ms: number, months: number): number {
	const d = new Date(ms)
	const year = d.getUTCFullYear()
	const month = d.getUTCMonth() - months
	// Day 0 of the following month is the last day of the one we landed in.
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

	return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay))
}

/** Every bucket start from `from` to `to` inclusive, one day apart. */
function dayBuckets(from: number, to: number): number[] {
	const out: number[] = []

	for (let ms = from; ms <= to; ms += MS_PER_DAY) {
		out.push(ms)
	}

	return out
}

/**
 * Every month start from the OLDEST bucket in `counts` through `to`, inclusive.
 *
 * The oldest bucket is read from the counts rather than from a second query for the earliest
 * shopOwner: the aggregation has already visited every document, so asking again would be a full
 * scan to learn something the result set already states. `$group` has no ordering guarantee, hence
 * the sort.
 *
 * ⚠️ `.slice(0, 1)` **is** the empty-collection case, and deliberately not an `if`. A platform with
 * no shopOwners has no oldest month, so the loop below never starts and the series is empty — an
 * axis drawn from nothing would have to invent its own endpoints, and a chart showing a flat zero
 * line for a platform with no shopOwners is indistinguishable from one whose query failed. An
 * explicit early return for that case is unobservable: the general path already answers `[]`, so
 * removing the guard changes no output, and a guard nothing can observe is a guard no test can hold
 * in place. As a one-element seed list it is the same decision, expressed where it can be checked.
 *
 * Stepped with `Date.UTC(y, m + 1, 1)` rather than by adding a fixed number of milliseconds: months
 * are 28 to 31 days long, so a millisecond step drifts and eventually skips or repeats one.
 */
function monthBuckets(counts: Map<string, number>, to: number): number[] {
	const out: number[] = []
	const last = startOfMonthUTC(to)

	for (const first of [...counts.keys()].sort().slice(0, 1)) {
		let ms = startOfMonthUTC(fromBucketKey(first))

		while (ms <= last) {
			out.push(ms)
			const d = new Date(ms)
			ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
		}
	}

	return out
}

/**
 * The grouped counts, keyed by bucket. Gaps are the database's silence — a day nobody registered on
 * produces no group at all — and are filled in by `series`.
 */
async function countsByBucket(from: number | null, format: string): Promise<Map<string, number>> {
	const pipeline: PipelineStage[] = []

	// Only the bounded ranges get a `$match`, and it is what the `{ registeredAt: 1 }` index in
	// marketplace-db-setup serves. `ALL` reads the whole collection by definition, so a stage matching
	// everything would only add work.
	if (from !== null) {
		pipeline.push({ $match: { registeredAt: { $gte: new Date(from) } } })
	}

	pipeline.push({
		$group: { _id: { $dateToString: { format, date: '$registeredAt', timezone: 'UTC' } }, total: { $sum: 1 } }
	})

	const rows = await ShopOwner.aggregate<{ _id: string; total: number }>(pipeline)

	return new Map(rows.map((r) => [r._id, r.total]))
}

/** Gap filling: every bucket in the range gets a point, and a bucket nobody registered in gets 0. */
function series(buckets: number[], counts: Map<string, number>): IShopOwnersPerPeriodPoint[] {
	return buckets.map((ms) => {
		const date = toBucketKey(ms)

		return { date, total: counts.get(date) ?? 0 }
	})
}

/**
 * One series, gap-filled, oldest point first.
 *
 * The two branches differ in where the series STARTS, and only there. A bounded range starts at a
 * date arithmetic can name before the query runs, so its `$match` and its buckets come from the same
 * number; the unbounded one has no such date and takes its start from what came back — see
 * `monthBuckets`.
 */
export default async function shopOwnersPerPeriodDb(period: ShopOwnersPeriod): Promise<IShopOwnersPerPeriod> {
	const { months, granularity, format } = RANGES[period]
	const today = startOfDayUTC(new Date())

	if (months === null) {
		const counts = await countsByBucket(null, format)

		return { granularity, points: series(monthBuckets(counts, today), counts) }
	}

	const from = subMonthsUTC(today, months)
	const counts = await countsByBucket(from, format)

	return { granularity, points: series(dayBuckets(from, today), counts) }
}
