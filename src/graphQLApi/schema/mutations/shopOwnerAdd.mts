import { GraphQLInputLogin } from '@axiumine/koa-utils/graphQL/schema/GraphQLInput/GraphQLInputLogin'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { IShopOwnerSchema } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IShopOwnerSchema'
import { assertPasswordByteLength } from '@axiumine/marketplace-common/others/assertPasswordByteLength'
import { GraphQLInputShopOwnerPersonalData } from '@axiumine/marketplace-common/schema/GraphQLInput/GraphQLInputShopOwnerPersonalData'
import { ILoginInput } from '@axiumine/marketplace-common/schema/interfaces/ILoginInput'
import { requiredEmail } from '@lib/validate/fields.mjs'
import { IShopOwnerPersonalDataInput, validateShopOwnerPersonalData } from '@lib/validate/validateShopOwnerPersonalData.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	login: ILoginInput
	personalData: IShopOwnerPersonalDataInput
}

export const shopOwnerAdd = {
	type: new GraphQLNonNull(GraphQLBoolean),
	description: 'adds a shopOwner',
	args: {
		login: { type: new GraphQLNonNull(GraphQLInputLogin) },
		personalData: { type: new GraphQLNonNull(GraphQLInputShopOwnerPersonalData) }
	},
	async resolve(_: unknown, args: IArgs) {
		// `await`, not `return ShopOwner.create(doc)`: without it the promise escaped the try, so
		// the catch could never run, and the mutation answered with the Mongoose document instead of
		// the declared Boolean — which GraphQLBoolean refuses to serialize. Now it matches its
		// siblings (shopOwnerDel / shopOwnerUpdate): do the work, rethrow, return true.
		try {
			// `login` gets the same treatment `shopOwnerUpdateEmail`/`funAdminUpdatePwd` give it, and every
			// sibling on this tier that writes a credential: `requiredEmail` trims and shape-checks, this
			// mutation lower-cases on top (the platform's own normalisation — see
			// `shopOwnerRegister`/`userRegister` on the public tier), and `checkPwdLen` enforces the same
			// bounds `funAdminUpdatePwd` does. Without either, `LoginSubDocSchema`'s `pre('save')` hashes
			// whatever it is given — including `''` — into a permanent, guessable credential.
			const email = requiredEmail(args.login.email.toLowerCase(), 'login.email')

			checkPwdLen(args.login.password)
			// `checkPwdLen` counts UTF-16 code units; this counts UTF-8 bytes, the unit bcrypt truncates
			// on. A password heavy in emoji, accents or CJK can clear the check above while still
			// running past 72 bytes. Same refusal shape as `checkPwdLen`'s own too-long branch — see the
			// helper's own doc.
			assertPasswordByteLength(args.login.password)

			// Validated *and normalised* before the write, exactly like `shopOwnerUpdate` — the
			// returned object is what reaches `create`, trimmed, with a blank landline dropped rather
			// than sent as null, and with the address point given the `type: 'Point'` the client never
			// sends. Both mutations take the same shared input type, so a coordinates-only point can
			// arrive here too; without this call it would be stored verbatim and rejected by the
			// collection validator as a 500 with nothing to tell the admin.
			const doc: IShopOwnerSchema = {
				// Minted here, not by Mongoose. Every model in marketplace-common declares `_id` explicitly
				// and without a default, which switches off auto-generation — so `create()` on a
				// document that has none throws "document must have an _id before saving" and never
				// reaches MongoDB. Same line every other *Add resolver on this tier carries (companyAdd).
				_id: new Types.ObjectId(),
				login: { email, password: args.login.password },
				personalData: validateShopOwnerPersonalData(args.personalData, new Date()),
				registeredAt: new Date()
			}

			await ShopOwner.create(doc)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
