import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const STATIC_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
let adminToken = null;

if (!STORE_DOMAIN || (!STATIC_TOKEN && !(CLIENT_ID && CLIENT_SECRET))) {
  console.error("Missing required environment variables:");
  console.error("- SHOPIFY_STORE_DOMAIN");
  console.error("- SHOPIFY_ADMIN_API_TOKEN OR SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET");
  process.exit(1);
}

const endpoint = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const tokenEndpoint = `https://${STORE_DOMAIN}/admin/oauth/access_token`;
const LOCAL_ASSETS_ROOT = path.join(ROOT, "static/shopify-assets");
const assetMap = new Map();
const assetDownloads = new Map();
let downloadedAssetCount = 0;
let skippedAssetCount = 0;
let skippedAssetLogCount = 0;
const MAX_ASSET_CONCURRENCY = 8;
let activeAssetDownloads = 0;
const assetWaitQueue = [];

async function getAdminToken() {
  if (adminToken) return adminToken;
  if (STATIC_TOKEN) {
    adminToken = STATIC_TOKEN;
    return adminToken;
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify token request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error(`Token response did not include access_token: ${JSON.stringify(payload)}`);
  }

  adminToken = payload.access_token;
  return adminToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAssetSlot(task) {
  if (activeAssetDownloads >= MAX_ASSET_CONCURRENCY) {
    await new Promise((resolve) => assetWaitQueue.push(resolve));
  }

  activeAssetDownloads += 1;
  try {
    return await task();
  } finally {
    activeAssetDownloads -= 1;
    const next = assetWaitQueue.shift();
    if (next) next();
  }
}

async function fetchWithRetry(url, init, retries = 3) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      if (response.ok) return response;
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`Retryable HTTP ${response.status} for ${url}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(500 * (attempt + 1));
      attempt += 1;
    }
  }

  throw lastError;
}

async function graphQL(query, variables = {}) {
  const token = await getAdminToken();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify API request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

function tomlEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function toToml(value) {
  if (value === null || value === undefined) return '""';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => toToml(entry)).join(", ")}]`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `"${tomlEscape(value)}"`;
}

function frontMatter(fields) {
  const lines = ["+++"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key} = ${toToml(value)}`);
  }
  lines.push("+++", "");
  return lines.join("\n");
}

function slugify(input, fallback = "item") {
  const slug = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function sanitizeHugoContent(html = "") {
  return String(html)
    .replace(/{{/g, "&#123;&#123;");
}

function isShopifyAssetHost(hostname = "") {
  return hostname.endsWith("cdn.shopify.com") || hostname.endsWith("shopifycdn.com");
}

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

function urlToLocalWebPath(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (!isShopifyAssetHost(parsed.hostname)) return null;

  let pathname = decodeURIComponent(parsed.pathname || "/");
  pathname = pathname.replace(/\/+/g, "/");
  pathname = pathname.replace(/\.\./g, "");
  if (pathname.endsWith("/")) pathname = `${pathname}index.bin`;
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  if (parsed.search) {
    const hash = crypto.createHash("sha1").update(parsed.search).digest("hex").slice(0, 8);
    const ext = path.posix.extname(pathname);
    if (ext) {
      pathname = `${pathname.slice(0, -ext.length)}-${hash}${ext}`;
    } else {
      pathname = `${pathname}-${hash}`;
    }
  }

  return `/shopify-assets/${parsed.hostname}${pathname}`;
}

async function localizeRemoteAsset(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  const localWebPath = urlToLocalWebPath(rawUrl);
  if (!normalized || !localWebPath) return rawUrl;

  if (assetMap.has(normalized)) {
    return assetMap.get(normalized);
  }

  if (!assetDownloads.has(normalized)) {
    const pending = (async () => {
      return withAssetSlot(async () => {
        const response = await fetchWithRetry(normalized, undefined, 4);
        if (!response.ok) {
          if (skippedAssetLogCount < 10) {
            console.warn(`Skipping missing/unavailable asset (${response.status}): ${normalized}`);
            skippedAssetLogCount += 1;
          }
          skippedAssetCount += 1;
          assetMap.set(normalized, rawUrl);
          return rawUrl;
        }

        const arrayBuffer = await response.arrayBuffer();
        const outputPath = path.join(ROOT, "static", localWebPath.slice(1));
        await ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
        assetMap.set(normalized, localWebPath);
        downloadedAssetCount += 1;
        return localWebPath;
      });
    })();

    assetDownloads.set(normalized, pending);
  }

  let localPath;
  try {
    localPath = await assetDownloads.get(normalized);
  } catch (error) {
    if (skippedAssetLogCount < 10) {
      console.warn(`Skipping asset due to download error: ${normalized}`);
      skippedAssetLogCount += 1;
    }
    skippedAssetCount += 1;
    assetMap.set(normalized, rawUrl);
    return rawUrl;
  }
  assetMap.set(normalized, localPath);
  return localPath;
}

async function localizeText(input = "") {
  const text = String(input);
  const matches = text.match(/(?:https?:)?\/\/[^\s"'<>`]+/g) || [];
  if (!matches.length) return text;

  let output = text;
  const seen = new Set();
  for (const rawUrl of matches) {
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) continue;
    const host = new URL(normalized).hostname;
    if (!isShopifyAssetHost(host)) continue;

    const localPath = await localizeRemoteAsset(rawUrl);
    output = output.split(rawUrl).join(localPath);
  }

  return output;
}

async function localizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return localizeText(value);
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => localizeValue(item)));
  }
  if (typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, entry]) => [key, await localizeValue(entry)])
    );
    return Object.fromEntries(entries);
  }
  return value;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function clearGeneratedContent(dirPath) {
  await ensureDir(dirPath);
  const names = await fs.readdir(dirPath);
  await Promise.all(names.map((name) => fs.rm(path.join(dirPath, name), { recursive: true, force: true })));
}

async function fetchAllProducts() {
  const query = `
    query Products($cursor: String) {
      products(first: 100, after: $cursor, sortKey: TITLE) {
        nodes {
          id
          title
          handle
          vendor
          productType
          tags
          createdAt
          updatedAt
          onlineStoreUrl
          descriptionHtml
          featuredImage {
            url
            altText
          }
          images(first: 10) {
            nodes {
              url
              altText
            }
          }
          variants(first: 20) {
            nodes {
              title
              sku
              availableForSale
              price
              compareAtPrice
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const items = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphQL(query, { cursor });
    items.push(...data.products.nodes);
    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return items;
}

async function fetchAllCollections() {
  const query = `
    query Collections($cursor: String) {
      collections(first: 100, after: $cursor, sortKey: TITLE) {
        nodes {
          id
          title
          handle
          descriptionHtml
          updatedAt
          image {
            url
            altText
          }
          productsCount {
            count
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const items = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphQL(query, { cursor });
    items.push(...data.collections.nodes);
    hasNextPage = data.collections.pageInfo.hasNextPage;
    cursor = data.collections.pageInfo.endCursor;
  }

  return items;
}

async function fetchAllPages() {
  const query = `
    query Pages($cursor: String) {
      pages(first: 100, after: $cursor, sortKey: TITLE) {
        nodes {
          id
          title
          handle
          body
          createdAt
          updatedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const items = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphQL(query, { cursor });
    items.push(...data.pages.nodes);
    hasNextPage = data.pages.pageInfo.hasNextPage;
    cursor = data.pages.pageInfo.endCursor;
  }

  return items;
}

async function fetchAllArticles() {
  const query = `
    query Articles($cursor: String) {
      articles(first: 100, after: $cursor, sortKey: PUBLISHED_AT) {
        nodes {
          id
          title
          handle
          body
          summary
          publishedAt
          updatedAt
          blog {
            title
            handle
          }
          image {
            url
            altText
          }
          author {
            name
          }
          tags
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const items = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphQL(query, { cursor });
    items.push(...data.articles.nodes);
    hasNextPage = data.articles.pageInfo.hasNextPage;
    cursor = data.articles.pageInfo.endCursor;
  }

  return items;
}

async function fetchShopMeta() {
  const query = `
    query ShopMeta {
      shop {
        name
        description
        primaryDomain {
          host
          url
        }
      }
    }
  `;

  const data = await graphQL(query);
  return data.shop;
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeMarkdown(filePath, fields, body = "") {
  await ensureDir(path.dirname(filePath));
  const text = `${frontMatter(fields)}${body}\n`;
  await fs.writeFile(filePath, text, "utf8");
}

async function writeProducts(products) {
  await clearGeneratedContent(path.join(ROOT, "content/products"));

  await Promise.all(
    products.map(async (product) => {
      const filename = `${slugify(product.handle || product.title, "product")}.md`;
      const filePath = path.join(ROOT, "content/products", filename);
      const body = await localizeText(sanitizeHugoContent(product.descriptionHtml || ""));
      const fields = await localizeValue({
        title: product.title,
        date: product.createdAt,
        lastmod: product.updatedAt,
        handle: product.handle,
        vendor: product.vendor,
        product_type: product.productType,
        tags: product.tags,
        online_store_url: product.onlineStoreUrl || "",
        featured_image: product.featuredImage?.url || "",
        featured_image_alt: product.featuredImage?.altText || "",
        images: (product.images?.nodes || []).map((img) => img.url),
        draft: false
      });

      return writeMarkdown(filePath, fields, body);
    })
  );

  await writeJson(path.join(ROOT, "data/shopify/products.json"), products);
}

async function writeCollections(collections) {
  await clearGeneratedContent(path.join(ROOT, "content/collections"));

  await Promise.all(
    collections.map(async (collection) => {
      const filename = `${slugify(collection.handle || collection.title, "collection")}.md`;
      const filePath = path.join(ROOT, "content/collections", filename);
      const body = await localizeText(sanitizeHugoContent(collection.descriptionHtml || ""));
      const fields = await localizeValue({
        title: collection.title,
        handle: collection.handle,
        date: collection.updatedAt,
        lastmod: collection.updatedAt,
        image: collection.image?.url || "",
        image_alt: collection.image?.altText || "",
        products_count: collection.productsCount?.count || 0,
        draft: false
      });

      return writeMarkdown(filePath, fields, body);
    })
  );

  await writeJson(path.join(ROOT, "data/shopify/collections.json"), collections);
}

async function writePages(pages) {
  await clearGeneratedContent(path.join(ROOT, "content/pages"));

  await Promise.all(
    pages.map(async (page) => {
      const filename = `${slugify(page.handle || page.title, "page")}.md`;
      const filePath = path.join(ROOT, "content/pages", filename);

      const fields = await localizeValue({
        title: page.title,
        handle: page.handle,
        date: page.createdAt,
        lastmod: page.updatedAt,
        draft: false
      });
      const body = await localizeText(sanitizeHugoContent(page.body || ""));
      return writeMarkdown(filePath, fields, body);
    })
  );

  await writeJson(path.join(ROOT, "data/shopify/pages.json"), pages);
}

async function writeArticles(articles) {
  await clearGeneratedContent(path.join(ROOT, "content/blog"));

  await Promise.all(
    articles.map(async (article) => {
      const blogHandle = slugify(article.blog?.handle || "blog", "blog");
      const articleSlug = slugify(article.handle || article.title, "article");
      const filePath = path.join(ROOT, "content/blog", `${blogHandle}-${articleSlug}.md`);

      const fields = await localizeValue({
        title: article.title,
        date: article.publishedAt || article.updatedAt,
        lastmod: article.updatedAt,
        blog_title: article.blog?.title || "Blog",
        blog_handle: article.blog?.handle || "blog",
        author: article.author?.name || "",
        tags: article.tags || [],
        excerpt: article.summary || "",
        image: article.image?.url || "",
        image_alt: article.image?.altText || "",
        draft: false
      });
      const body = await localizeText(sanitizeHugoContent(article.body || ""));
      return writeMarkdown(filePath, fields, body);
    })
  );

  await writeJson(path.join(ROOT, "data/shopify/articles.json"), articles);
}

async function main() {
  const authMode = STATIC_TOKEN ? "static admin token" : "client credentials grant";
  console.log(`Exporting Shopify content from ${STORE_DOMAIN} (API ${API_VERSION}, auth: ${authMode})...`);
  await clearGeneratedContent(LOCAL_ASSETS_ROOT);

  const [shop, products, collections, pages, articles] = await Promise.all([
    fetchShopMeta(),
    fetchAllProducts(),
    fetchAllCollections(),
    fetchAllPages(),
    fetchAllArticles()
  ]);

  await Promise.all([
    writeProducts(products),
    writeCollections(collections),
    writePages(pages),
    writeArticles(articles),
    writeJson(path.join(ROOT, "data/shopify/shop.json"), shop)
  ]);

  await writeMarkdown(path.join(ROOT, "content/_index.md"), {
    title: shop.name || "Store Archive",
    draft: false
  }, await localizeText(`<p>${sanitizeHugoContent(shop.description || "Archived storefront content from Shopify.")}</p>`));

  console.log(`Done. Exported: ${products.length} products, ${collections.length} collections, ${pages.length} pages, ${articles.length} articles, ${downloadedAssetCount} local assets, ${skippedAssetCount} skipped assets.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
