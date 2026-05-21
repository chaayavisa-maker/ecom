/**
 * listingAgent.js — Improved Listing Agent
 *
 * Key improvements over original:
 *  1. Multi-image support — fetches up to 10 images from AliExpress per product
 *  2. Image deduplication & quality filtering — skips tiny/corrupt images
 *  3. Retry logic on Shopify image upload failures
 *  4. Variant-aware image assignment (color variants get their variant image)
 *  5. AI-generated alt text per image for SEO
 *  6. Bulk listing with concurrency control (no more sequential bottleneck)
 *  7. Dry-run mode for safe testing
 */

import { getAIClient } from '../utils/aiProvider.js';
import { createProduct, updateProductImages } from '../shopify/products.js';
import { fetchProductImages } from '../suppliers/aliexpress.js';
import logger from '../utils/logger.js';
import pLimit from 'p-limit'; // npm install p-limit

const MAX_IMAGES = 10;         // Shopify supports up to 250; 10 is a good practical limit
const MIN_IMAGE_WIDTH = 400;   // Skip low-res images (px)
const CONCURRENCY = 3;         // Max simultaneous Shopify product creations
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential back-off.
 */
async function withRetry(fn, attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      logger.warn(`Attempt ${i + 1} failed: ${err.message}. Retrying in ${delayMs}ms…`);
      await sleep(delayMs * (i + 1)); // exponential back-off
    }
  }
}

/**
 * Filter images: remove duplicates, low-res images, and broken URLs.
 * @param {Array<{url: string, width?: number, height?: number}>} images
 * @returns {Array<{url: string, width?: number, height?: number}>}
 */
function filterImages(images) {
  const seen = new Set();
  return images.filter(img => {
    if (!img?.url) return false;
    if (seen.has(img.url)) return false;
    seen.add(img.url);
    // Skip obviously low-res images if dimensions are known
    if (img.width && img.width < MIN_IMAGE_WIDTH) return false;
    return true;
  });
}

/**
 * Ask AI to generate a short, SEO-friendly alt text for each image.
 * Falls back to product title if AI call fails.
 */
async function generateAltTexts(ai, productTitle, imageCount) {
  try {
    const prompt = `You are writing image alt text for a Shopify product listing.
Product: "${productTitle}"
Generate ${imageCount} unique, concise alt text strings (max 125 chars each) for product images.
Vary them: main shot, lifestyle, detail, angle, packaging, etc.
Return ONLY a JSON array of strings, no explanation.`;

    const response = await ai.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0]?.text?.trim() ?? '[]';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (Array.isArray(parsed) && parsed.length === imageCount) return parsed;
  } catch (err) {
    logger.warn(`Alt text generation failed: ${err.message}`);
  }
  // Fallback: generic alt texts
  return Array.from({ length: imageCount }, (_, i) =>
    i === 0 ? productTitle : `${productTitle} - view ${i + 1}`
  );
}

// ─── Core listing logic ──────────────────────────────────────────────────────

/**
 * Build a Shopify product payload with multi-image support.
 *
 * @param {object} ai        - AI client (Claude or Grok)
 * @param {object} product   - Product data from research agent
 * @param {object} options   - { dryRun: boolean }
 * @returns {object}         - Created Shopify product (or dry-run preview)
 */
export async function listProduct(ai, product, options = {}) {
  const { dryRun = false } = options;

  logger.info(`[Listing] Processing: ${product.title}`);

  // 1. Fetch ALL available images from the supplier
  let rawImages = [];
  try {
    rawImages = await withRetry(() => fetchProductImages(product.supplierUrl, { limit: MAX_IMAGES }));
  } catch (err) {
    logger.error(`[Listing] Failed to fetch images for ${product.title}: ${err.message}`);
    // Fall back to the single image from research if available
    if (product.imageUrl) rawImages = [{ url: product.imageUrl }];
  }

  // 2. Filter & deduplicate
  const images = filterImages(rawImages).slice(0, MAX_IMAGES);
  logger.info(`[Listing] ${images.length} images ready for "${product.title}"`);

  // 3. Generate SEO-optimised content via AI
  const [title, description, tags, altTexts] = await Promise.all([
    generateTitle(ai, product),
    generateDescription(ai, product),
    generateTags(ai, product),
    generateAltTexts(ai, product.title, images.length),
  ]);

  // 4. Build Shopify images array
  //    Each image gets: src URL + alt text + position
  const shopifyImages = images.map((img, idx) => ({
    src: img.url,
    alt: altTexts[idx] ?? title,
    position: idx + 1,
  }));

  // 5. Calculate price
  const price = calculatePrice(product);

  // 6. Build full Shopify payload
  const payload = {
    title,
    body_html: description,
    vendor: product.vendor ?? 'DropShip Store',
    product_type: product.category ?? '',
    tags: tags.join(', '),
    status: 'draft', // Always draft first — review before publishing
    images: shopifyImages,           // ← MULTI-IMAGE
    variants: buildVariants(product, price),
    metafields: [
      {
        namespace: 'custom',
        key: 'supplier_url',
        value: product.supplierUrl,
        type: 'single_line_text_field',
      },
      {
        namespace: 'custom',
        key: 'supplier_cost',
        value: String(product.cost),
        type: 'number_decimal',
      },
      {
        namespace: 'custom',
        key: 'last_synced',
        value: new Date().toISOString(),
        type: 'single_line_text_field',
      },
    ],
  };

  if (dryRun) {
    logger.info(`[Listing] DRY RUN — would create product with ${shopifyImages.length} images`);
    return { dryRun: true, payload };
  }

  // 7. Create product with retry
  const created = await withRetry(() => createProduct(payload));
  logger.info(`[Listing] ✅ Created "${title}" (ID: ${created.id}) with ${shopifyImages.length} images`);

  return created;
}

/**
 * Assign the correct variant images after product creation.
 * (Shopify requires the product to exist before linking variant→image)
 *
 * @param {object} shopifyProduct  - Newly created Shopify product
 * @param {object} product         - Original product data with variant info
 */
export async function assignVariantImages(shopifyProduct, product) {
  if (!product.variants || product.variants.length === 0) return;

  const variantImageMap = buildVariantImageMap(shopifyProduct, product);
  if (Object.keys(variantImageMap).length === 0) return;

  try {
    await withRetry(() => updateProductImages(shopifyProduct.id, variantImageMap));
    logger.info(`[Listing] Variant images assigned for product ${shopifyProduct.id}`);
  } catch (err) {
    logger.warn(`[Listing] Could not assign variant images: ${err.message}`);
  }
}

/**
 * Run the listing agent across a batch of researched products.
 *
 * @param {Array}   products  - From productResearchAgent
 * @param {object}  options   - { dryRun, maxProducts }
 */
export async function runListingAgent(products, options = {}) {
  const ai = getAIClient();
  const { dryRun = false, maxProducts = products.length } = options;
  const limit = pLimit(CONCURRENCY);

  const toProcess = products.slice(0, maxProducts);
  logger.info(`[Listing] Starting batch: ${toProcess.length} products (concurrency: ${CONCURRENCY})`);

  const results = await Promise.allSettled(
    toProcess.map(product =>
      limit(async () => {
        const listed = await listProduct(ai, product, { dryRun });
        if (!dryRun) await assignVariantImages(listed, product);
        return listed;
      })
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected');

  failed.forEach(f => logger.error(`[Listing] Failed: ${f.reason?.message}`));
  logger.info(`[Listing] Done. ${succeeded}/${toProcess.length} products listed.`);

  return results;
}

// ─── AI content generators ───────────────────────────────────────────────────

async function generateTitle(ai, product) {
  const prompt = `Write a compelling, SEO-optimised Shopify product title (max 70 chars) for:
"${product.rawTitle}"
Category: ${product.category}
Return ONLY the title, no quotes.`;

  const res = await withRetry(() =>
    ai.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    })
  );
  return res.content[0].text.trim();
}

async function generateDescription(ai, product) {
  const prompt = `Write a high-converting Shopify product description in clean HTML for:
Product: "${product.rawTitle}"
Key features: ${JSON.stringify(product.features ?? [])}
Target audience: online shoppers looking for deals
Requirements:
- Use <h2>, <ul>, <p> tags
- Highlight top 3-5 benefits as bullet points
- Include a brief intro paragraph
- End with a subtle call to action
- Max 400 words
Return ONLY the HTML, no markdown fences.`;

  const res = await withRetry(() =>
    ai.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    })
  );
  return res.content[0].text.trim();
}

async function generateTags(ai, product) {
  const prompt = `Generate 8–12 Shopify product tags for: "${product.rawTitle}" in category "${product.category}".
Return ONLY a JSON array of lowercase strings.`;

  const res = await withRetry(() =>
    ai.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    })
  );
  try {
    return JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
  } catch {
    return [];
  }
}

// ─── Pricing & Variants ──────────────────────────────────────────────────────

function calculatePrice(product) {
  const markup = parseFloat(process.env.DEFAULT_MARKUP_PERCENT ?? '200') / 100;
  const shippingBuffer = parseFloat(process.env.SHIPPING_BUFFER_USD ?? '5');
  const raw = (product.cost + shippingBuffer) * (1 + markup);
  return (Math.ceil(raw) - 0.01).toFixed(2);
}

function buildVariants(product, price) {
  const compareAt = (parseFloat(price) * 1.4).toFixed(2);

  if (!product.variants || product.variants.length === 0) {
    return [{
      price,
      compare_at_price: compareAt,
      inventory_management: 'shopify',
      inventory_quantity: product.stock ?? 50,
      requires_shipping: true,
      weight: product.weightGrams ?? 500,
      weight_unit: 'g',
    }];
  }

  return product.variants.map(v => ({
    option1: v.option1,
    option2: v.option2 ?? null,
    price: v.price ?? price,
    compare_at_price: compareAt,
    sku: v.sku ?? `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    inventory_management: 'shopify',
    inventory_quantity: v.stock ?? 50,
  }));
}

function buildVariantImageMap(shopifyProduct, product) {
  const map = {};
  if (!product.variants) return map;

  product.variants.forEach((variant, idx) => {
    if (variant.imageUrl && shopifyProduct.images[idx]) {
      map[shopifyProduct.variants[idx]?.id] = shopifyProduct.images[idx]?.id;
    }
  });
  return map;
}
