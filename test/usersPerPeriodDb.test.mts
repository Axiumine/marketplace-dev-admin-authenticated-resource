import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userAggregate = vi.fn()
const shopOwnerAggregate = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({
	User: { aggregate: userAggregate }
}))
// Mocked only so the wrong-collection assertion below has something to be silent. Nothing in this
// file imports the shopOwner lib.
vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { aggregate: shopOwnerAggregate }
}))

const { default: usersPerPeriodDb } = await import('../src/lib/user/usersPerPeriodDb.mts')

/**
 * ⚠️ **The bucket arithmetic is NOT re-tested here** — it lives in `@lib/stats/registeredAtSeriesDb.mjs`
 * and `shopOwnersPerPeriodDb.test.mts` drives every branch of it: the three ranges, the month-length
 * clamp, the gap filling, the empty collection. Repeating those cases against `User` would assert the
 * same lines twice and quietly claim the two libs are independent, which is the opposite of the design.
 *
 * What this file owns is the part that is NOT shared: which collection the customers series reads, and
 * that the shared machinery is reached with the period it was given.
 */

/** Only `Date` is faked — see the note in shopOwnersPerPeriodDb.test.mts. */
function todayE(iso: string) {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date(iso))
}

describe('usersPerPeriodDb', () => {
	beforeEach(() => {
		userAggregate.mockReset()
		shopOwnerAggregate.mockReset()
	})
	afterEach(() => vi.useRealTimers())

	// ⚠️ The assertion that matters most in this file, and the one a copy-paste breaks: the two libs are
	// two lines each over one shared file, so passing `ShopOwner` here would answer a perfectly
	// well-formed series of the wrong people and fail nothing else in this repo.
	it('reads the user collection and never the shopOwner one', async () => {
		todayE('2026-08-02T09:30:00.000Z')
		userAggregate.mockResolvedValueOnce([{ _id: '2026-07-01', total: 4 }])

		await expect(usersPerPeriodDb('ALL')).resolves.toEqual({
			granularity: 'MONTH',
			points: [
				{ date: '2026-07-01', total: 4 },
				{ date: '2026-08-01', total: 0 }
			]
		})

		expect(shopOwnerAggregate).not.toHaveBeenCalled()
	})

	// The period reaches the shared lib rather than being defaulted or dropped on the way: a bounded
	// range is the only one that produces a `$match`, so its presence IS the evidence the argument
	// arrived. One month before 2 August is 2 July, and the day format is what the range picked.
	it('hands the period through to the shared series lib', async () => {
		todayE('2026-08-02T09:30:00.000Z')
		userAggregate.mockResolvedValueOnce([])

		const { granularity, points } = await usersPerPeriodDb('ONE_MONTH')

		expect(granularity).toBe('DAY')
		expect(points.at(0)).toEqual({ date: '2026-07-02', total: 0 })
		expect(points.at(-1)).toEqual({ date: '2026-08-02', total: 0 })
		expect(userAggregate.mock.calls[0][0]).toEqual([
			{ $match: { registeredAt: { $gte: new Date('2026-07-02T00:00:00.000Z') } } },
			{
				$group: {
					_id: { $dateToString: { format: '%Y-%m-%d', date: '$registeredAt', timezone: 'UTC' } },
					total: { $sum: 1 }
				}
			}
		])
	})
})
