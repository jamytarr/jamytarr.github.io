# Shopify -> Hugo -> GitHub Pages

This project exports Shopify content into a Hugo static site so you can keep your storefront content online without running the Shopify app.  
test

## What it exports
- Products
- Collections
- Pages
- Blogs and articles
- Basic shop metadata
- Shopify CDN assets downloaded into `static/shopify-assets/` so pages can serve media locally

## Prerequisites
- Node.js 20+
- Hugo extended (for local builds)
- A Shopify app installed on your store with read scopes:
  - `read_products`
  - `read_content`

## Environment variables
Create a `.env` file (or export env vars in your shell/CI):

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id
SHOPIFY_CLIENT_SECRET=your_client_secret
# Optional fallback:
# SHOPIFY_ADMIN_API_TOKEN=shpat_xxx
SHOPIFY_API_VERSION=2025-10
```

`SHOPIFY_API_VERSION` is optional and defaults to `2025-10`.
If `SHOPIFY_ADMIN_API_TOKEN` is not set, the exporter automatically requests a token using
the Shopify client credentials grant.

## Run export locally

```bash
npm run export
```

Then build the static site:

```bash
hugo --minify
```

The generated site is in `public/`.

## GitHub Pages deployment
This repo includes `.github/workflows/deploy-pages.yml`.

Set these repo secrets:
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_ADMIN_API_TOKEN` (optional fallback)
- `SHOPIFY_API_VERSION` (optional)

Then enable GitHub Pages to deploy from GitHub Actions.

## Notes
- Export overwrites generated content in `content/products`, `content/collections`, `content/pages`, and `content/blog`.
- Export also overwrites `static/shopify-assets` with freshly downloaded Shopify CDN assets.
