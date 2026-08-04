import { IContextAdminAuthenticatedResource } from '@lib/auth/IContextAdminAuthenticatedResource.mjs'
import { GraphQLAdminInfoAfterLogin } from '@ptypes/GraphQLAdminInfoAfterLogin.mjs'
import { GraphQLNonNull } from 'graphql'

export const infoAdminAfterLogin = {
	description: 'Info after login',
	type: new GraphQLNonNull(GraphQLAdminInfoAfterLogin),
	async resolve(_: unknown, {}, ctx: IContextAdminAuthenticatedResource) {
		const user = ctx.state.user

		return {
			_id: user._id,
			email: user.email
		}
	}
}
