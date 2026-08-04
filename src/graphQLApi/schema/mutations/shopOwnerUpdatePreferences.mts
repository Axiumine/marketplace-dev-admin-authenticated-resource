import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { funShopOwnerUpdatePreferences } from '@lib/shopOwner/funShopOwnerUpdatePreferences.mjs'
import { optionalText } from '@lib/validate/fields.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

/** `login.onboardingStep` is `string, maxLength: 4` in the collection validator. */
const MAX_ONBOARDING_STEP = 4

interface IArgs {
	_id: Types.ObjectId
	rememberMe: boolean
	onboardingDone: boolean
	onboardingStep?: string | null
}

/**
 * The three preference fields under `login`.
 *
 * `onboardingStep` is the only nullable argument, and here `null` genuinely means "clear it": the field
 * is optional on the collection, so an operator emptying the box is asking for it to be gone. The two
 * booleans are required for the reason spelled out in `shopOwnerUpdateStatus`.
 */
export const shopOwnerUpdatePreferences = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'updates the login preferences of the shopOwner',
	args: {
		_id: { type: new GraphQLNonNull(GraphQLID) },
		rememberMe: { type: new GraphQLNonNull(GraphQLBoolean) },
		onboardingDone: { type: new GraphQLNonNull(GraphQLBoolean) },
		onboardingStep: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IArgs) {
		try {
			await funShopOwnerUpdatePreferences(
				args._id,
				args.rememberMe,
				args.onboardingDone,
				optionalText(args.onboardingStep, 'onboardingStep', MAX_ONBOARDING_STEP)
			)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
