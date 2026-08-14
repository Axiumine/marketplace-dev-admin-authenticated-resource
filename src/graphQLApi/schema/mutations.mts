import { GraphQLObjectType } from 'graphql'

import { adminUpdatePwd } from './mutations/adminUpdatePwd.mjs'
import { companyAdd } from './mutations/companyAdd.mjs'
import { companyDel } from './mutations/companyDel.mjs'
import { companyUpdate } from './mutations/companyUpdate.mjs'
import { companyUpdatePublished } from './mutations/companyUpdatePublished.mjs'
import { itemCategoryAdd } from './mutations/itemCategoryAdd.mjs'
import { itemCategoryDel } from './mutations/itemCategoryDel.mjs'
import { itemCategoryUpdate } from './mutations/itemCategoryUpdate.mjs'
import { itemDel } from './mutations/itemDel.mjs'
import { itemUpdatePublished } from './mutations/itemUpdatePublished.mjs'
import { keygripRetire } from './mutations/keygripRetire.mjs'
import { keygripRotate } from './mutations/keygripRotate.mjs'
import { revokeAllSessions } from './mutations/revokeAllSessions.mjs'
import { revokeSession } from './mutations/revokeSession.mjs'
import { shopOwnerAdd } from './mutations/shopOwnerAdd.mjs'
import { shopOwnerDel } from './mutations/shopOwnerDel.mjs'
import { shopOwnerUpdate } from './mutations/shopOwnerUpdate.mjs'
import { shopOwnerUpdateEmail } from './mutations/shopOwnerUpdateEmail.mjs'
import { shopOwnerUpdateNote } from './mutations/shopOwnerUpdateNote.mjs'
import { shopOwnerUpdatePreferences } from './mutations/shopOwnerUpdatePreferences.mjs'
import { shopOwnerUpdateStatus } from './mutations/shopOwnerUpdateStatus.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		adminUpdatePwd,
		shopOwnerAdd,
		shopOwnerDel,
		shopOwnerUpdate,
		shopOwnerUpdateEmail,
		shopOwnerUpdateNote,
		shopOwnerUpdatePreferences,
		shopOwnerUpdateStatus,
		companyAdd,
		companyDel,
		companyUpdate,
		companyUpdatePublished,
		itemCategoryAdd,
		itemCategoryDel,
		itemCategoryUpdate,
		itemDel,
		itemUpdatePublished,
		keygripRotate,
		keygripRetire,
		revokeSession,
		revokeAllSessions
	}
})

export default MutationsApi
