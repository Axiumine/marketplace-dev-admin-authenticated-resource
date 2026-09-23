import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { throwInternalError } from '@axiumine/koa-utils/graphQL/throw/throwInternalError'
import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { compareHashAsync } from '@axiumine/koa-utils/lib/hash'
import { Admin } from '@axiumine/marketplace-common/models/MongoDB/Admin'
import { assertPasswordByteLength } from '@axiumine/marketplace-common/others/assertPasswordByteLength'
import { checkUserAuthorizationDisDel } from '@axiumine/marketplace-common/others/checkUserAuthorizationDisDel'
import { guardAdminUpdatePwdWrite } from '@lib/admin/guardAdminUpdatePwdWrite.mjs'
import { Types } from 'mongoose'

/**
 * Changes the authenticated admin's own password.
 *
 * The `_id` is the session's, never the client's — see the mutation. Everything below is about the
 * one operation this must not become: a way to set someone else's password, or to confirm a guess
 * about the current one.
 */
export async function funAdminUpdatePwd(_id: Types.ObjectId, passwordOld: string, passwordNew: string) {
	// The platform's own bounds (koa-utils Constants: 10 minimum, 72 maximum), not a local pair of
	// numbers. The maximum is the one that is easy to dismiss and must not be: bcrypt hashes at most
	// 72 bytes and silently ignores everything after them, so without an upper bound a 200-character
	// passphrase would be stored as its first 72 characters while the admin believes otherwise.
	// The OLD password is deliberately not length-checked — it is compared, not accepted, and
	// validating it would only report which guesses were the wrong shape.
	checkPwdLen(passwordNew)
	// `checkPwdLen` counts UTF-16 code units; this counts UTF-8 bytes, the unit bcrypt truncates on. A
	// password heavy in emoji, accents or CJK can clear the check above while still running past 72
	// bytes. Same refusal shape as `checkPwdLen`'s own too-long branch — see the helper's own doc.
	assertPasswordByteLength(passwordNew)

	// Rejected because it is almost always an accident, and because letting it through would spend a
	// bcrypt hash at cost factor 14 to write back a value that is already there.
	if (passwordNew === passwordOld) {
		throwErrorWrongUserInput('passwordNew must differ from passwordOld')
	}

	// The platform's only defense against a stolen admin bearer token being upgraded into a permanent
	// password change, metered before the read below for the same reason `guardKeygripWrite` guards the
	// read it precedes: a runaway client is refused for the price of one INCR, not a document fetch and a
	// bcrypt compare.
	await guardAdminUpdatePwdWrite(_id.toString())

	// `login.password` is read because it has to be compared. The projection is explicit so nothing
	// else about the account is pulled into memory alongside a value this sensitive.
	const admin = await Admin.findById(_id).select('_id disabled deleted login.password').lean()

	// A session whose admin document no longer exists. 401, not 404: the caller learns their session
	// is no good, and nothing more.
	if (admin === null) {
		throwUnauthorizedError()
	}

	// Same gate every other authenticated path uses. A disabled or soft-deleted admin keeps a live
	// access token until it expires, and must not be able to change the password on the way out.
	checkUserAuthorizationDisDel(admin)

	// The re-authentication step, and the reason this mutation takes the old password at all. An
	// access token is a bearer credential: whoever holds one is already inside. Proving knowledge of
	// the current password is what stops a stolen token from being upgraded into permanent ownership
	// of the account.
	if (!(await compareHashAsync(passwordOld, admin.login.password))) {
		// Deliberately the same error as the missing-document branch above, for the same reason the
		// login form does not distinguish "no such user" from "wrong password".
		throwUnauthorizedError()
	}

	// Hashed here rather than through the model: `updateOne` is a query, and the `pre('save')` hook in
	// marketplace-common's LoginSubDocSchema that normally hashes `password` only runs for documents. Left
	// to the hook, this would store the plaintext.
	const password = await encryptPassword(passwordNew)

	const ret = await Admin.updateOne({ _id: _id }, { $set: { 'login.password': password } }).exec()

	// The document was read a moment ago and the hash is salted, so it cannot match what is stored —
	// `modifiedCount` of anything but 1 means the write did not land, and the caller must not be told
	// their password changed when it did not.
	if (ret.modifiedCount !== 1) {
		throwInternalError()
	}
}
