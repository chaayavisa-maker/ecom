/**
 * listingAgent.js — Listing Agent
 *
 * Change from previous version:
 *   products are published immediately when AUTO_PUBLISH_PRODUCTS=true,
 *   otherwise they remain as 'draft' for manual review.
 *
 * All other logic (multi-image, alt text, retry, pricing) is unchanged.
 */

'use strict';

const ai = require('../utils/aiProvider');
const { createProduct, addImagesToProduct, updateVariantImage } = require('../shopify/products');
const { fetchProductImages } = require('../suppliers/aliexpress');
const logger = require('../utils/logger');

const MAX_IMAGES    = 10;
const RETRY_ATTEMPTS = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function withRetry(fn, label = 'operation') {
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === RETRY_ATTEMPTS - 1) throw err;
      const delay = 1500 * (i + 1);
      logger.warn(`[Listing] ${label} attempt ${i + 1} failed: ${err.message}. Retry in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// ─── AI content generators ────────────────────────────────────────────────────

async function generateTitle(product) {
  return ai.chat({
    system: 'You write short, SEO-optimised Shopify product titles. Return ONLY the title — no quotes, no explanation.',
    prompt: `Write a compelling Shopify product title (max 70 chars) for: "${product.rawTitle || product.title}"
Category: ${product.category || product.niche || 'General'}`,
    maxTokens: 80,
  });
}

async function generateDescription(product) {
  return ai.chat({
    system: 'You write high-converting Shopify product descriptions in clean HTML. Return ONLY the HTML — no markdown fences.',
    prompt: `Write a product description for: "${product.rawTitle || product.title}"
Features: ${JSON.stringify(product.features || [])}
Use <h2>, <ul>, <p> tags. Include a short intro, 3–5 benefit bullets, and a soft call to action. Max 400 words.`,
    maxTokens: 900,
  });
}

async function generateTagsAndAltTexts(product, imageCount) {
  const result = await ai.chatJSON({
    system: 'You generate Shopify product metadata. Respond ONLY with valid JSON.',
    prompt: `Product: "${product.rawTitle || product.title}"
Category: ${product.category || product.niche || 'General'}

Return a JSON object with:
- "tags": array of 8–12 lowercase Shopify tags
- "altTexts": array of ${imageCount} unique image alt texts (max 125 chars each, vary them: main shot, lifestyle, detail, angle, etc.)`,
    maxTokens: 500,
  });
  return {
    tags:     Array.isArray(result.tags)     ? result.tags     : [],
    altTexts: Array.isArray(result.altTexts) ? result.altTexts : [],
  };
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

function calculatePrice(cost) {
  const markup         = parseFloat(process.env.DEFAULT_MARKUP_PERCENT || '200') / 100;
  const shippingBuffer = parseFloat(process.env.SHIPPING_BUFFER_USD    || '5');
  const raw = (cost + shippingBuffer) * (1 + markup);
  return (Math.ceil(raw) - 0.01).toFixed(2);
}

function calculateCompareAt(sellPrice) {
  const multiplier = parseFloat(process.env.COMPARE_AT_MULTIPLIER || '1.4');
  return (Math.ceil(parseFloat(sellPrice) * multiplier) - 0.01).toFixed(2);
}

// ─── Core listing ─────────────────────────────────────────────────────────────

async function listProduct(product) {
  const productLabel = product.rawTitle || product.title || product.productId;
  logger.info(`[Listing] Processing: ${productLabel}`);

  // 1. Fetch images
  let images = [];
  try {
    images = await withRetry(
      () => fetchProductImages(product.supplierUrl || product.productUrl, { limit: MAX_IMAGES }),
      'fetchImages'
    );
  } catch (err) {
    logger.warn(`[Listing] Image fetch failed for "${productLabel}": ${err.message}`);
  }

  if (images.length === 0 && product.imageUrl) {
    images = [{ url: product.imageUrl, position: 1, isMain: true }];
  }

  logger.info(`[Listing] ${images.length} image(s) ready for "${productLabel}"`);

  // 2. Generate AI content in parallel
  const [title, description, meta] = await Promise.all([
    generateTitle(product),
    generateDescription(product),
    generateTagsAndAltTexts(product, images.length).catch(() => ({ tags: [], altTexts: [] })),
  ]);

  // 3. Pricing
  const cost      = product.cost || product.price || 8;
  const price     = calculatePrice(cost);
  const compareAt = calculateCompareAt(price);

  // 4. Build Shopify images array
  const shopifyImages = images.map((img, idx) => ({
    src:      img.url,
    alt:      meta.altTexts[idx] || title,
    position: idx + 1,
  }));

  // 5. Publish status — controlled by AUTO_PUBLISH_PRODUCTS in .env
  //    'active'  → goes live immediately on your store
  //    'draft'   → saved but not visible to shoppers
  const publishStatus = process.env.AUTO_PUBLISH_PRODUCTS === 'true' ? 'active' : 'draft';

  // 6. Build full Shopify product payload
  const payload = {
    title,
    body_html:    description,
    vendor:       product.vendor || process.env.STORE_VENDOR || 'Our Store',
    product_type: product.category || product.niche || '',
    tags:         meta.tags.join(', '),
    status:       publishStatus,
    images:       shopifyImages,
    variants: [{
      price,
      compare_at_price:     compareAt,
      inventory_management: 'shopify',
      inventory_quantity:   product.stock || 50,
      requires_shipping:    true,
    }],
    metafields: [
      {
        namespace: 'custom',
        key:       'supplier_url',
        value:     product.supplierUrl || product.productUrl || '',
        type:      'single_line_text_field',
      },
      {
        namespace: 'custom',
        key:       'supplier_cost',
        value:     String(cost),
        type:      'number_decimal',
      },
      {
        namespace: 'custom',
        key:       'last_synced',
        value:     new Date().toISOString(),
        type:      'single_line_text_field',
      },
    ],
  };

  // 7. Create the product on Shopify
  const created = await withRetry(() => createProduct(payload), 'createProduct');
  logger.info(
    `[Listing] ✅ Created "${title}" (ID: ${created.id}) — status: ${publishStatus} — ${shopifyImages.length} image(s)`
  );

  return created;
}

// ─── Agent class ──────────────────────────────────────────────────────────────

class ListingAgent {
  constructor() {
    this.name = 'ListingAgent';
  }

  async bulkProcess(products) {
    const publishMode = process.env.AUTO_PUBLISH_PRODUCTS === 'true' ? 'LIVE' : 'DRAFT';
    logger.info(`🤖 ${this.name} started — listing ${products.length} product(s) as ${publishMode} [provider: ${ai.providerName}]`);
    const results = { created: 0, failed: 0 };

    for (const product of products) {
      try {
        await listProduct(product);
        results.created++;
        await sleep(1000); // Pace Shopify API calls
      } catch (err) {
        logger.error(`[Listing] Failed to list "${product.rawTitle || product.title}": ${err.message}`);
        results.failed++;
      }
    }

    logger.info(`✅ ${this.name} complete — created: ${results.created}, failed: ${results.failed}`);
    return results;
  }

  async run(products = []) {
    return this.bulkProcess(products);
  }
}

module.exports = new ListingAgent();
