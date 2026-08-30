import type { Mock } from 'vitest'
import { vi } from 'vitest'

/** The links of the chain a paged table query walks: find → select → sort → skip → limit → lean. */
export interface ITblQueryChain {
	select: Mock
	sort: Mock
	skip: Mock
	limit: Mock
	lean: Mock
}

/**
 * Mongoose's query builder, faked one link per chained call.
 *
 * The two admin tables — `shopOwnersActiveTblDb` and `usersActiveTblDb` — walk the same chain in the same
 * order over two different collections, so the arming is the one part worth sharing: what differs is the
 * projection each asserts and the filter each builds, and those stay in the suites.
 *
 * The `find` mock is passed in rather than created here, for `sessionIndexMocks.mts`'s reason: `vi.mock`
 * is hoisted to the top of the file that declares it, so the model each suite fakes has to be built in
 * that suite's own module.
 *
 * `mockReturnValueOnce`, not `mockReturnValue`: a resolver that called `find` twice would otherwise be
 * handed the same builder again and the second call would go unnoticed.
 *
 * Not a `*.test.mts` file on purpose: the unit project collects `test/*.test.mts`, so this sits beside the
 * suites without becoming one.
 */
export function mockFindChain(find: Mock, items: unknown[]): ITblQueryChain {
	const lean = vi.fn().mockResolvedValue(items)
	const limit = vi.fn().mockReturnValue({ lean })
	const skip = vi.fn().mockReturnValue({ limit })
	const sort = vi.fn().mockReturnValue({ skip })
	const select = vi.fn().mockReturnValue({ sort })

	find.mockReturnValueOnce({ select })

	return { select, sort, skip, limit, lean }
}

/** The filter the resolver handed `find` — the first argument of its first call. */
export function filterOf(find: Mock): Record<string, unknown> {
	return find.mock.calls[0][0]
}
