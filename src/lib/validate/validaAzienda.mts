import {
	emailObbligatoria,
	FORMA_PIVA,
	FORMA_UNIVOCO,
	testoConFormato,
	testoObbligatorio,
	testoOpzionaleConFormato,
	testoOpzionaleLunghezzaEsatta
} from '@lib/validate/campi.mjs'
import { IIndirizzoInput, validaIndirizzo } from '@lib/validate/validaIndirizzo.mjs'
import { IAziendaSchema } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IAziendaSchema'

/*
 * From marketplace-db-setup/migrations/20260803000000-create-azienda.js.
 *
 * The bounds are `20260301000200-create-puntoVendita.js`'s embedded `azienda` sub-document, which is
 * where these fields lived until 20260803000100 lifted them into a collection — with two differences,
 * both deliberate and both in that migration:
 *
 *   - `visura` was unbounded and is capped at 1000. It holds the uploaded file's path, not the
 *     document, and it was the only string on the collection able to absorb an arbitrarily long value.
 *   - `cf` is new. Exactly 11 characters, optional, and not unique — a company's codice fiscale usually
 *     equals its partita IVA, which `piva_unique` already covers.
 */
const MAX_RAGIONE_SOCIALE = 100
const MAX_REFERENTE = 50
const MAX_AMMINISTRATORE = 50
const MAX_VISURA = 1000
const LUNGHEZZA_CF = 11

/** What the `GraphQLInputAzienda` argument carries: the stored document minus the fields nobody sends. */
export type IAziendaInput = Omit<IAziendaSchema, '_id' | 'idImprenditore' | 'indirizzo' | '__v'> & {
	indirizzo: IIndirizzoInput
}

/**
 * The same fields, normalised and ready to be written whole.
 *
 * `_id` and `idImprenditore` stay out: the first is minted by `funAziendaAdd`, the second is a separate
 * argument on the create path and is **never** written by the update path — moving a company between
 * owners is not a flow anybody has asked for, and `$set` of this object cannot do it by accident.
 */
export type IAziendaValidata = Omit<IAziendaSchema, '_id' | 'idImprenditore' | '__v'>

/**
 * A company, every field of it.
 *
 * `cf` and `univoco` are the two optional ones and are dropped from the object entirely when blank
 * rather than written as null: `additionalProperties: false` plus `bsonType: 'string'` means a cleared
 * box sent as `null` — which is what GraphQL serialises it to — fails the whole write.
 *
 * The path prefix is `azienda.` throughout because the fields arrive inside one input object, which is
 * the argument the operator's form maps onto.
 */
export const validaAzienda = (azienda: IAziendaInput): IAziendaValidata => {
	const cf = testoOpzionaleLunghezzaEsatta(azienda.cf, 'azienda.cf', LUNGHEZZA_CF)
	const univoco = testoOpzionaleConFormato(
		azienda.univoco,
		'azienda.univoco',
		FORMA_UNIVOCO,
		'il codice univoco è di 7 caratteri alfanumerici'
	)

	return {
		ragionesociale: testoObbligatorio(azienda.ragionesociale, 'azienda.ragionesociale', MAX_RAGIONE_SOCIALE),
		piva: testoConFormato(azienda.piva, 'azienda.piva', FORMA_PIVA, 'la partita IVA è di 11 cifre'),
		...(cf === undefined ? {} : { cf }),
		referente: testoObbligatorio(azienda.referente, 'azienda.referente', MAX_REFERENTE),
		amministratore: testoObbligatorio(azienda.amministratore, 'azienda.amministratore', MAX_AMMINISTRATORE),
		...(univoco === undefined ? {} : { univoco }),
		pec: emailObbligatoria(azienda.pec, 'azienda.pec'),
		indirizzo: validaIndirizzo(azienda.indirizzo, 'azienda.indirizzo'),
		visura: testoObbligatorio(azienda.visura, 'azienda.visura', MAX_VISURA)
	}
}
