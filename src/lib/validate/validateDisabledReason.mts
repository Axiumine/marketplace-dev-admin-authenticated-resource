import { requiredText } from '@lib/validate/fields.mjs'

/**
 * The cap on an operator's suspension note, and **the only place it is enforced on the platform**.
 *
 * ⚠️ **The collection cannot carry this bound and never will.** `disabledReason` is encrypted with
 * `ALGORITHM_RANDOM` (ADR-044), so it reaches MongoDB as `binData` and `$jsonSchema` admits no
 * `maxLength` on a blob. The validator still enforces that the field is *present* whenever `disabled` is
 * true — `dependencies: { disabled: ['disabledReason'] }` asserts existence and reads nothing — but the
 * length is this service's rule alone, and a write that bypasses this service can exceed it.
 *
 * This is not ADR-035 being reversed: that decision put `maxItems` in the validator because the
 * validator could see the value. Here it cannot, and the choice was never "validator or service" but
 * "encrypt the operator's prose about a person, or count its characters".
 */
export const MAX_DISABLED_REASON = 1000

/**
 * The reason an operator gives for a suspension: required when suspending, discarded when releasing.
 *
 * ⚠️ **A reason sent alongside `disabled: false` is dropped, not refused.** The mutation's contract is a
 * target state rather than a transition — both flags arrive on every save — so a form that keeps the old
 * text in its textarea while the operator unticks the box is describing "not suspended", and answering
 * that with a 400 would be the service arguing with a request it understood perfectly. What comes back
 * is `undefined`, which is what `funShopOwnerUpdateStatus` turns into the `$unset` that clears the stored
 * reason: releasing an account removes all three `disabled*` fields together, because a stale reason
 * standing beside a live account is worse than no reason at all.
 *
 * ⚠️ **`requiredText` and not `optionalText`, when suspending.** The blank string, the string of spaces
 * and the missing argument are one case here — an operator who suspends somebody owes a sentence, and
 * the whole point of ADR-044 is that the account can say why. `requiredText` trims, refuses empty with a
 * 400 naming the field, and refuses anything over the cap with a 400 saying what the cap is; the
 * alternative was letting `''` through to a `dependencies` rule that would happily accept it.
 */
export const validateDisabledReason = (disabled: boolean, reason: string | null | undefined): string | undefined =>
	disabled ? requiredText(reason ?? '', 'disabledReason', MAX_DISABLED_REASON) : undefined
