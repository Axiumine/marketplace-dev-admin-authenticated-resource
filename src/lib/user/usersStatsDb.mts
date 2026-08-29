import { User } from '@axiumine/marketplace-common/models/MongoDB/User'

/**
 * Every customer ever registered, `shopOwnersStatsDb` over the other collection.
 *
 * ⚠️ **No filter, deliberately** — closed and suspended accounts count. It is the total the chart's
 * points add up to, and two numbers on one screen that look like the same number must be the same
 * number. Since ADR-041 a closed account keeps its document for ever, so this total never goes down.
 */
export default async function usersStatsDb() {
	return User.countDocuments()
}
