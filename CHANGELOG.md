# TechBuilders Restaurant v4

## Added
- Transaction-based daily order numbering: `YY-MM-DD-sequence`.
- Dine-in/takeaway selection and configurable per-service tax/fee lines.
- Active orders separated from a latest-10 completed-order archive with date/order-number search and pagination.
- Owner order editor for adding/removing lines, quantities and notes, and recalculating totals/taxes.
- Employee account creation through a secondary Firebase Auth app, with Firestore section permissions.
- Centralized logo URL and palette settings stored in `settings/restaurant`.
- Legacy completed orders migrate to the archive when the owner opens the admin panel.
- Isolated customer anonymous authentication from the admin authentication session.

## Preserved
- Existing book-style Arabic RTL menu.
- Firebase menu/settings/orders model.
- Cloudflare Pages Functions Telegram notification endpoint and Cloudflare secrets approach.
- GPS restaurant-radius check.

## Not included
- Sham Cash or any other payment-gateway integration.

## Notes
- Publish the v4 `firestore.rules` before testing new orders, staff accounts, archive actions or order edits.
- Keep the actual Firebase web config and Cloudflare Secrets from the working deployment; they are intentionally not embedded in this package.

- Expanded employee view permissions to cover overview, groups, categories, items, active orders, and archive; menu sections remain read-only for staff.
