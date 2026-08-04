import { GraphQLObjectType } from 'graphql'

import { adminUpdatePwd } from './mutations/adminUpdatePwd.mjs'
import { aziendaAdd } from './mutations/aziendaAdd.mjs'
import { aziendaDel } from './mutations/aziendaDel.mjs'
import { aziendaUpdate } from './mutations/aziendaUpdate.mjs'
import { imprenditoreAdd } from './mutations/imprenditoreAdd.mjs'
import { imprenditoreDel } from './mutations/imprenditoreDel.mjs'
import { imprenditoreUpdate } from './mutations/imprenditoreUpdate.mjs'
import { imprenditoreUpdateEmail } from './mutations/imprenditoreUpdateEmail.mjs'
import { imprenditoreUpdateNote } from './mutations/imprenditoreUpdateNote.mjs'
import { imprenditoreUpdatePreferenze } from './mutations/imprenditoreUpdatePreferenze.mjs'
import { imprenditoreUpdateStato } from './mutations/imprenditoreUpdateStato.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		adminUpdatePwd,
		imprenditoreAdd,
		imprenditoreDel,
		imprenditoreUpdate,
		imprenditoreUpdateEmail,
		imprenditoreUpdateNote,
		imprenditoreUpdatePreferenze,
		imprenditoreUpdateStato,
		aziendaAdd,
		aziendaDel,
		aziendaUpdate
	}
})

export default MutationsApi
