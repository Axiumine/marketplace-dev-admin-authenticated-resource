# marketplace-dev-admin-authenticated-resource

Domain GraphQL for the **Admin** tier — the platform operator's view of every shop owner, every shop and
the shared category tree. Port **4024**, endpoint `/admin-authenticated-resource`.

Token lifecycle is not here: `marketplace-dev-admin-authenticated-authorization` (4025) refreshes the
session and `marketplace-dev-authenticated-logout` (4030) ends it.

## What it answers

| Mutations | |
|---|---|
| `shopOwnerAdd`, `shopOwnerUpdate`, `shopOwnerDel` | the accounts themselves |
| `shopOwnerUpdateStatus` | `disabled` and `waitApprov` only — `deleted` is a timestamp and belongs to `shopOwnerDel` |
| `shopOwnerUpdateEmail`, `shopOwnerUpdateNote`, `shopOwnerUpdatePreferences` | contact, internal notes, flags |
| `companyAdd`, `companyUpdate`, `companyDel` | any shop, not only the caller's |
| `itemCategoryAdd`, `itemCategoryUpdate`, `itemCategoryDel` | **the only place category writes exist** |
| `itemDel`, `itemUpdatePublished` | moderation — take an entry down or unpublish it |
| `companyUpdatePublished` | the shop's own publish switch — see below |
| `adminUpdatePwd` | the operator's own password |

| Queries | |
|---|---|
| `infoAdminAfterLogin` | what the admin SPA loads on entry |
| `shopOwnerById`, `shopOwnersActiveTbl`, `shopOwnerCompanies`, `companyItems` | the operator's drill-down path |
| `itemCategories` | the tree, readable everywhere, writable only here |
| `shopOwnersStats`, `shopOwnersPerPeriod` | dashboard aggregates |

## What will bite you here

⚠️ **The mutation names overlap `marketplace-dev-authenticated-resource` on purpose, and the resolvers are
not the same.** `companyAdd` here writes any shop; there it writes only the caller's, behind
`throwIfShopOwnerDontOwnCompany`. Copying a resolver between the two repos because the signature matches
carries the wrong ownership assumption across a tier boundary — in one direction it breaks the admin, in
the other it hands every shop owner the platform.

⚠️ **Publishing is a separate operation, not a field of the card.** `published` is deliberately absent
from `GraphQLInputCompany`: `companyUpdate` `$set`s the whole object, so a flag inside the input would
make every save a write of the flag — and an operator who reopened a form loaded before somebody
unpublished a shop would put it straight back without asking to. `companyAdd` stamps `false`;
`companyUpdatePublished` is the only writer of the flag, matching `itemUpdatePublished` beside it and the
same pair on 4026.

A shop also has to be nameable before it can be published: the collection's `$expr` refuses
`published: true` without both `slug` and `publicName`, so the save comes first and the publish second.
An item is publicly visible only if its company is published too, which makes this switch a takedown of
the whole catalogue in one write.

⚠️ **`itemCategory` writes live only here** because the tree is shared by every shop. `idParent` is a
self-FK with **one level only** — a category or a subcategory, never a third level. Nothing in the
`$jsonSchema` enforces the depth.

⚠️ **The catalogue is domain-neutral (ADR-008).** Category names arriving through these mutations are
data; do not add fields or validation that presume what is being sold.

⚠️ **Boolean flags are `$unset` when false, never written as `false`.** `funShopOwnerUpdateStatus` and
`funShopOwnerDelete` both do this, and the reason is in their comments: `false` is legal BSON, so storing
it leaves the collection holding two spellings of one state and a later `{ waitApprov: { $exists: true } }`
starts matching accounts that are not waiting. A new flag added here follows the same rule.

⚠️ **Setting `waitApprov` does not lock the account out.** Nothing on the login path reads it — see
`marketplace-dev-public-authorization`'s README. An operator who expects "awaiting approval" to mean
"cannot log in" is expecting something this platform does not do.

## Related files

| Topic | File |
|---|---|
| rules for agents working in this repo | [`CLAUDE.md`](./CLAUDE.md) |
| git hooks, gate order, node selection | [`REPO.md`](./REPO.md) |
| the whole platform — tiers, ports, terminology | parent [`CLAUDE.md`](./CLAUDE.md) |

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
