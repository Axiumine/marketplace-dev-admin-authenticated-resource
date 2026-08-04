import { optionalText } from '@lib/validate/fields.mjs'

/**
 * The `shopOwner` collection's own bound, read off
 * marketplace-db-setup/migrations/20260802000300-alter-shopOwner-position-note.js. Named rather than
 * inlined for the same reason the personalData bounds are: nothing else on this document is capped at
 * 2000, so an inlined literal would read as arbitrary.
 */
const MAX_NOTE = 2000

/**
 * The operator's note about an account: trimmed, at most 2000 characters, and `''` when blank.
 *
 * `?? ''` rather than letting the `undefined` through, because `''` is not a discarded value here — it
 * is the instruction `funShopOwnerUpdateNote` reads as "remove the note". Everywhere else on this
 * document an optional text field comes back `undefined` so the key can be left out of a `$set` that
 * replaces a whole sub-document; `notes` is a top-level scalar written on its own, so clearing it is an
 * `$unset` and needs a value that says so.
 */
export const validateShopOwnerNote = (notes: string): string => optionalText(notes, 'notes', MAX_NOTE) ?? ''
