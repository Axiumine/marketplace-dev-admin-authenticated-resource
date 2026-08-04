import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const aggregate = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore', () => ({
	Imprenditore: { aggregate }
}))

const { default: imprenditoriPerPeriodoDb } = await import('../src/lib/imprenditore/imprenditoriPerPeriodoDb.mts')

/**
 * Only `Date` is faked. Vitest's default set also replaces `setTimeout` and friends, which nothing
 * here advances — an await that lands on a faked timer would simply never settle and the test would
 * hang rather than fail.
 */
function oggiE(iso: string) {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date(iso))
}

/** The `$group` stage, spelled out rather than imported: see the note in imprenditoriAttiviTblDb.test.mts. */
function gruppo(format: string) {
	return {
		$group: { _id: { $dateToString: { format, date: '$iscrizione', timezone: 'UTC' } }, totale: { $sum: 1 } }
	}
}

function righe(rows: Array<{ _id: string; totale: number }>) {
	aggregate.mockResolvedValueOnce(rows)
}

function pipeline() {
	return aggregate.mock.calls[0][0]
}

describe('imprenditoriPerPeriodoDb', () => {
	beforeEach(() => aggregate.mockReset())
	afterEach(() => vi.useRealTimers())

	describe('TUTTO', () => {
		// The rows come back out of order and with a hole in the middle, because both are what a real
		// `$group` produces: it has no ordering guarantee at all, and a month nobody registered in
		// yields no group rather than a zero. The series must still start at the OLDEST month — which
		// is what separates `Math.min` from `Math.max` over the returned keys — run to the current
		// month even though the last two are empty, and carry a 0 for the month in the gap.
		it('runs from the oldest month the database returned to the current one, gaps filled', async () => {
			oggiE('2026-08-02T09:30:00.000Z')
			righe([
				{ _id: '2026-06-01', totale: 2 },
				{ _id: '2026-04-01', totale: 5 }
			])

			await expect(imprenditoriPerPeriodoDb('TUTTO')).resolves.toEqual({
				granularita: 'MESE',
				punti: [
					{ data: '2026-04-01', totale: 5 },
					{ data: '2026-05-01', totale: 0 },
					{ data: '2026-06-01', totale: 2 },
					{ data: '2026-07-01', totale: 0 },
					{ data: '2026-08-01', totale: 0 }
				]
			})
		})

		// No `$match`: the unbounded range reads the whole collection by definition, and a stage that
		// matched everything would only add work. One stage, and the format is what stamps a month
		// bucket with its own first day so the client has a single date format to parse.
		it('groups by month with no range stage at all', async () => {
			oggiE('2026-08-02T09:30:00.000Z')
			righe([{ _id: '2026-08-01', totale: 1 }])

			await imprenditoriPerPeriodoDb('TUTTO')

			expect(pipeline()).toEqual([gruppo('%Y-%m-01')])
		})

		// A platform with no imprenditori has no oldest month, so there is no axis to draw. Answering
		// with a flat zero line instead would be indistinguishable on screen from a query that failed.
		it('answers with no points at all when the collection is empty', async () => {
			oggiE('2026-08-02T09:30:00.000Z')
			righe([])

			await expect(imprenditoriPerPeriodoDb('TUTTO')).resolves.toEqual({ granularita: 'MESE', punti: [] })
		})

		// Stepped by calendar month, not by a fixed number of milliseconds: February is 28 days and
		// July is 31, so a millisecond step drifts and eventually repeats or skips a month. A year
		// boundary is where the drift and the month arithmetic are both visible at once.
		it('steps by calendar month across a year boundary', async () => {
			oggiE('2026-02-15T00:00:00.000Z')
			righe([{ _id: '2025-11-01', totale: 4 }])

			await expect(imprenditoriPerPeriodoDb('TUTTO')).resolves.toEqual({
				granularita: 'MESE',
				punti: [
					{ data: '2025-11-01', totale: 4 },
					{ data: '2025-12-01', totale: 0 },
					{ data: '2026-01-01', totale: 0 },
					{ data: '2026-02-01', totale: 0 }
				]
			})
		})
	})

	describe('TRE_MESI', () => {
		it('covers three months back to today, one point per day', async () => {
			oggiE('2026-08-02T23:59:00.000Z')
			righe([{ _id: '2026-07-04', totale: 3 }])

			const serie = await imprenditoriPerPeriodoDb('TRE_MESI')

			expect(serie.granularita).toBe('GIORNO')
			// 2 May → 2 August inclusive: 30 + 30 + 31 + 2.
			expect(serie.punti).toHaveLength(93)
			expect(serie.punti[0]).toEqual({ data: '2026-05-02', totale: 0 })
			expect(serie.punti[92]).toEqual({ data: '2026-08-02', totale: 0 })
			expect(serie.punti.find((p) => p.data === '2026-07-04')).toEqual({ data: '2026-07-04', totale: 3 })
		})

		// The `$match` is what the `{ iscrizione: 1 }` index in marketplace-db-setup serves, and its bound
		// is midnight UTC of the range's first day — not the current time of day three months back,
		// which would drop the earliest bucket's morning and leave the chart's first point short.
		it('bounds the scan at midnight UTC of the range start', async () => {
			oggiE('2026-08-02T23:59:00.000Z')
			righe([])

			await imprenditoriPerPeriodoDb('TRE_MESI')

			expect(pipeline()).toEqual([
				{ $match: { iscrizione: { $gte: new Date('2026-05-02T00:00:00.000Z') } } },
				gruppo('%Y-%m-%d')
			])
		})
	})

	describe('UN_MESE', () => {
		it('covers one month back to today, one point per day', async () => {
			oggiE('2026-08-02T00:00:00.000Z')
			righe([{ _id: '2026-08-02', totale: 1 }])

			const serie = await imprenditoriPerPeriodoDb('UN_MESE')

			expect(serie.granularita).toBe('GIORNO')
			// 2 July → 2 August inclusive: 30 + 2.
			expect(serie.punti).toHaveLength(32)
			expect(serie.punti[0]).toEqual({ data: '2026-07-02', totale: 0 })
			expect(serie.punti[31]).toEqual({ data: '2026-08-02', totale: 1 })
			expect(pipeline()).toEqual([
				{ $match: { iscrizione: { $gte: new Date('2026-07-02T00:00:00.000Z') } } },
				gruppo('%Y-%m-%d')
			])
		})

		/*
		 * ⚠️ The reason `subMonthsUTC` clamps. `Date.UTC(2026, 1, 31)` is not 31 February, it is 3
		 * March — the constructor rolls the overflow forward — so "one month before 31 March" would
		 * answer 3 March and hand back a 29-day range the operator asked for a month of. 28 February
		 * is the only reading of "a month ago" a calendar supports, and it is what the clamp produces.
		 */
		it('lands on the last day of a shorter month rather than overflowing into the next one', async () => {
			oggiE('2026-03-31T12:00:00.000Z')
			righe([])

			const serie = await imprenditoriPerPeriodoDb('UN_MESE')

			expect(serie.punti[0]).toEqual({ data: '2026-02-28', totale: 0 })
			// 28 February → 31 March inclusive: 1 + 31.
			expect(serie.punti).toHaveLength(32)
		})

		// The same subtraction, one range further back, is where the month index goes negative.
		// `Date.UTC` reads month -1 as December of the previous year, which is the behaviour the range
		// relies on instead of carrying the year by hand.
		it('carries the year when the range start falls before January', async () => {
			oggiE('2026-01-15T00:00:00.000Z')
			righe([])

			const serie = await imprenditoriPerPeriodoDb('TRE_MESI')

			expect(serie.punti[0]).toEqual({ data: '2025-10-15', totale: 0 })
		})
	})
})
