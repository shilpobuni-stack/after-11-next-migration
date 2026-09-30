# Vite → Next.js migration audit

Source: `shilpobuni-stack/After-10-parivartan` at commit `dc0f86a5614dc6bf3ae5c68a36bb3ad8f7ed150a` (2026-09-30 audit).

## Preserved
- All existing storefront, admin, modal, checkout, policy, coupon, merchant and settings components; Bengali text; the complete original CSS (`src/index.css`); default catalog and existing data mapping.
- App Router paths `/`, `/shop`, `/shades`, `/about`, `/privacy-policy`, `/terms`, `/return-policy` and `/admin/[[...section]]`. Existing URLs, query parameters and product quick-view behavior are retained using a small Next navigation compatibility layer. Products originally open in a modal rather than a dedicated product URL.
- Existing Supabase tables (`products`, `categories`, `orders`, `settings`, `coupons`, `merchants`), Auth and `product-images` storage. No database creation, reseeding or migration was performed.
- Existing API handlers execute on the server behind `src/app/api/[resource]/route.ts`; server-side merchant authorization remains in `src/server/api/_auth.js`.

## Security and behavior adjustments
- Browser auth uses publishable key only; the existing service-role client remains server-only.
- Admin UI access now checks `/api/merchants` after Auth sign-in; authenticated non-merchants cannot enter the restricted admin UI.
- Checkout rejects missing/invalid quantities, duplicates, invalid region, unavailable products/shades and mismatched totals; calculates product price, coupon, delivery and totals on server from database values, and checks transaction ID for mobile transfer.
- Stock deduction is not fully transactional across multiple products and order creation, because the existing schema has shades in JSONB and no transaction/RPC for stock + order. A future atomic Postgres function and guarded deployment would be required to eliminate all concurrent-checkout and partial-stock-update edge cases; no production schema was modified here.

## Source limitations (not silently filled in)
- Original repository contains no `public/images/` directory, although its catalog and metadata reference `/images/...`. Live database product URLs may still work, but missing local images must be restored from original production assets before launch.
- Original checkout has COD, bKash, Nagad, Rocket and “কার্ড / অন্যান্য (ডেলিভারিতে)”; no dedicated Bank Transfer option or separate payment-status field/workflow exists in the checked-in source. Original order note stores payment info/TrxID; admin manages order status. Those cannot be claimed as preserved source features.
- Original `public/sitemap.xml` uses relative `<loc>` values. Replace/verify with the real canonical domain if search indexing requires absolute URLs.

## Required Vercel environment
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`: publishable project URL/key (public values also in `.env.production`).
- `SUPABASE_SERVICE_ROLE_KEY`: required server-only for existing privileged database/storage operations. Add in Vercel Secrets; never prefix with `NEXT_PUBLIC_`.
- `ADMIN_EMAILS`: optional comma-separated original bootstrap merchant emails; alternatively existing `merchants` table contains authorized email entries.
- `NEXT_PUBLIC_SITE_URL`: production origin for canonical/OG metadata (set to actual production domain).
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`: optional existing email notifications; when absent orders still work without email.

No auth users, buckets, rows, migrations or RLS policies were changed by this migration.
