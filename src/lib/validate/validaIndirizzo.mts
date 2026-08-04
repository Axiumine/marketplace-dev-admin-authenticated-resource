import { coordinate, FORMA_CAP, FORMA_PROVINCIA, testoConFormato, testoObbligatorio } from '@lib/validate/campi.mjs'
import { IIndAzienda } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IAziendaSchema'

/*
 * The one address validator on this tier, for `azienda.indirizzo`.
 *
 * Until 2026-08-04 this also served `puntoVendita.indirizzo` — the two collections stored the same
 * shape, the same bounds and the same tuple-form GeoJSON point, which is why the function was written
 * generic on a `prefisso` path rather than hard-coded to one caller. `puntoVendita` is gone along with
 * every mutation that took an address, so `azienda` is the only caller left; the generic shape stayed
 * rather than being collapsed into `validaAzienda.mts`, since nothing about it is azienda-specific.
 *
 * ⚠️ `MAX_INDIRIZZO` is 100 here and 250 on an imprenditore. Same field name, same fragment on the
 * GraphQL side, different collections and different caps — the imprenditore validator lives in
 * validaAnagraficaImprenditore.mts and must stay there.
 */
const MAX_INDIRIZZO = 100
const MAX_COMUNE = 100

/** The only value `position.type` may hold — the Mongoose model declares it as an enum of one. */
const TIPO_POSIZIONE = 'Point'

/**
 * What an address input carries: the four address fields, and a position that is coordinates only.
 *
 * `position.type` is deliberately absent — see `validaIndirizzo`: this service owns its own input type,
 * shaped so there is no way to get the GeoJSON type wrong.
 */
export type IIndirizzoInput = Omit<IIndAzienda, 'position'> & { position: { coordinates: number[] } }

/**
 * An address, including its GeoJSON point.
 *
 * `prefisso` is the path the fields hang off in the mutation that called — `azienda.indirizzo`, since
 * the address arrives inside the `azienda` input object. The operator reads that path in the error
 * message, so it has to name the box they are actually looking at. The parameter stayed generic rather
 * than hard-coded to that one literal on the same reasoning the module doc-comment gives.
 *
 * `position.type` is **written**, not read off the argument. There is exactly one legal value, the
 * collection caps the field at 5 characters and the model declares it as an enum of one — so accepting
 * it from the client would only create a way to get it wrong, and a `type: 'point'` in the wrong case
 * is a document that fails validation for a reason no operator typed.
 */
export const validaIndirizzo = (indirizzo: IIndirizzoInput, prefisso: string): IIndAzienda => ({
	indirizzo: testoObbligatorio(indirizzo.indirizzo, `${prefisso}.indirizzo`, MAX_INDIRIZZO),
	cap: testoConFormato(indirizzo.cap, `${prefisso}.cap`, FORMA_CAP, 'il CAP è di 5 cifre'),
	comune: testoObbligatorio(indirizzo.comune, `${prefisso}.comune`, MAX_COMUNE),
	provincia: testoConFormato(
		indirizzo.provincia,
		`${prefisso}.provincia`,
		FORMA_PROVINCIA,
		'la provincia è la sigla di 2 lettere'
	).toUpperCase(),
	position: {
		type: TIPO_POSIZIONE,
		coordinates: coordinate(indirizzo.position.coordinates, `${prefisso}.position.coordinates`)
	}
})
