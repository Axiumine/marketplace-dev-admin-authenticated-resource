import { throwNotFoundError } from '@axiumine/koa-utils/graphQL/throw/throwNotFoundError'
import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
import { Types } from 'mongoose'

/**
 * The three preference fields, all of which live **under `login`** — not at the top level.
 * `login.rememberMe`, `login.onboardingStep`, `login.onboardingDone`, per the collection validator and
 * `ILoginSubDocSchema`. Written at the root they would be rejected by `additionalProperties: false`
 * rather than silently landing in the wrong place, but the error would name the root object and not the
 * mistake.
 *
 * The two booleans are `$set` to whatever they are, **false included** — unlike `disabled` and
 * `waitApprov` in `funShopOwnerUpdateStatus`, which are removed when false. The difference is not
 * arbitrary: those two are documented in the validator as flags whose *absence* is the "everything is
 * fine" state, and one of them backs the approval queue. Nothing reads these three by existence, so
 * `rememberMe: false` is simply the value, and storing it keeps "the operator turned this off" distinct
 * from "this account has never had a preference recorded".
 *
 * `onboardingStep` is the exception, because it is the one that can genuinely be *not set*: blank
 * arrives here as `undefined` from `testoOpzionale` and removes the field, since the collection types
 * it `string` and would reject a `null` for the whole write.
 */
export async function funShopOwnerUpdatePreferences(
	_id: Types.ObjectId,
	rememberMe: boolean,
	onboardingDone: boolean,
	onboardingStep: string | undefined
) {
	const set: Record<string, boolean | string> = {
		'login.rememberMe': rememberMe,
		'login.onboardingDone': onboardingDone
	}
	const unset: Record<string, 1> = {}

	if (onboardingStep === undefined) unset['login.onboardingStep'] = 1
	else set['login.onboardingStep'] = onboardingStep

	const ret = await ShopOwner.updateOne({ _id: _id }, { $set: set, $unset: unset }).exec()

	if (ret.matchedCount !== 1) throwNotFoundError('shopOwner not found')
}
