import {
	coordinate,
	dataNascita,
	emailObbligatoria,
	FORMA_CAP,
	FORMA_PROVINCIA,
	testoConFormato,
	testoObbligatorio,
	testoOpzionale
} from '@lib/validate/campi.mjs'
import {
	IAnagraficaImprenditore,
	IIndImprenditore
} from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IAnagraficaImprenditore'

/*
 * The bounds below are the `imprenditore` collection's own, read off
 * marketplace-db-setup/migrations/20260301000100-create-imprenditore.js. They are named rather than
 * inlined because two of them are easy to assume and wrong: an imprenditore's street address is capped
 * at 250, while the same field on an azienda is capped at 100 (see `validaIndirizzo.mts`), and both
 * phone numbers are 12 — not the 15 an E.164 number can reach.
 */
const MAX_NOME = 100
const MAX_COGNOME = 100
const MAX_INDIRIZZO = 250
const MAX_COMUNE = 100
const MAX_TELEFONO = 12

/** The only value `indirizzo.position.type` may hold — the Mongoose model declares it as an enum of one. */
const TIPO_POSIZIONE = 'Point'

/**
 * What the admin-side `anagrafica` input carries: everything the stored shape has, except that the
 * address point is **optional** and is coordinates only.
 *
 * Both differences are deliberate. Optional, because the field was added long after the collection was
 * filled and cannot be back-derived from a street address — the operator app sends it the first time an
 * address is picked from the autocomplete and not before. Coordinates only, because `type` has exactly
 * one legal value and accepting it from the client would only create a way to get it wrong — the same
 * reasoning `validaIndirizzo.mts` applies to the azienda address.
 */
export type IAnagraficaImprenditoreInput = Omit<IAnagraficaImprenditore, 'indirizzo'> & {
	indirizzo: Omit<IIndImprenditore, 'position'> & { position?: { coordinates: number[] } | null }
}

/**
 * Checks and normalises an incoming `anagrafica` before it replaces the stored one.
 *
 * Returns a **new** object rather than mutating the argument, and the caller writes that: the returned
 * value is trimmed, has its provincia upper-cased, and — the part that matters for the write — carries
 * no key at all for a landline that was left blank. `$set: { anagrafica }` replaces the whole
 * sub-document, so a `fisso` present with value `null` or `undefined` is not "unchanged", it is a value
 * of the wrong type for a `bsonType: 'string'` property and it fails the entire update.
 *
 * `oggi` is threaded in rather than read from the clock here so the majority boundary is testable from
 * both sides without freezing time.
 */
export const validaAnagraficaImprenditore = (anagrafica: IAnagraficaImprenditoreInput, oggi: Date): IAnagraficaImprenditore => {
	const fisso = testoOpzionale(anagrafica.contatti.fisso, 'contatti.fisso', MAX_TELEFONO)

	// `== null` on purpose: absent and explicitly null both mean "this address has no point", and the
	// GraphQL input makes the field nullable, so the client can send either.
	const position = anagrafica.indirizzo.position == null ? undefined : anagrafica.indirizzo.position

	return {
		nome: testoObbligatorio(anagrafica.nome, 'nome', MAX_NOME),
		cognome: testoObbligatorio(anagrafica.cognome, 'cognome', MAX_COGNOME),
		nascita: { data: dataNascita(anagrafica.nascita.data, 'nascita.data', oggi) },
		indirizzo: {
			indirizzo: testoObbligatorio(anagrafica.indirizzo.indirizzo, 'indirizzo.indirizzo', MAX_INDIRIZZO),
			cap: testoConFormato(anagrafica.indirizzo.cap, 'indirizzo.cap', FORMA_CAP, 'il CAP è di 5 cifre'),
			comune: testoObbligatorio(anagrafica.indirizzo.comune, 'indirizzo.comune', MAX_COMUNE),
			// Upper-cased on the way in, so `mi` and `MI` are one value in the database rather than two
			// that sort apart and compare unequal. The pattern accepts either case on purpose — refusing
			// a lower-case sigla would be a validation error over something the server can simply fix.
			provincia: testoConFormato(
				anagrafica.indirizzo.provincia,
				'indirizzo.provincia',
				FORMA_PROVINCIA,
				'la provincia è la sigla di 2 lettere'
			).toUpperCase(),
			// Spread rather than `position: undefined`, for the same reason `fisso` is spread below:
			// `$set: { anagrafica }` replaces the whole sub-document and the BSON serialiser encodes an
			// explicit `undefined` as `null`, which `bsonType: 'object'` rejects. An address saved
			// without a point therefore stores no `position` key at all.
			...(position === undefined
				? {}
				: {
						position: {
							type: TIPO_POSIZIONE,
							coordinates: coordinate(position.coordinates, 'indirizzo.position.coordinates')
						}
					})
		},
		contatti: {
			cellulare: testoObbligatorio(anagrafica.contatti.cellulare, 'contatti.cellulare', MAX_TELEFONO),
			// Spread, not `fisso: undefined`. The key has to be absent from the object, not present
			// holding nothing: the BSON serialiser encodes an explicit `undefined` as `null` unless
			// `ignoreUndefined` is set, and `null` is what the collection validator rejects.
			...(fisso === undefined ? {} : { fisso }),
			email: emailObbligatoria(anagrafica.contatti.email, 'contatti.email')
		}
	}
}
