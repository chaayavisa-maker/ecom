/**
 * productResearchAgent.js — Improved Product Research Agent (CJS)
 *
 * Improvements over original:
 *  1. Supplier URL de-duplication — skips products already in your store
 *  2. Richer AI scoring — now rates competition, saturation & shipping feasibility
 *  3. Niche blacklist — skip oversaturated categories
 *  4. 24h in-memory cache — don't re-research the same niche in the same day
 *  5. Fixed exports — module.exports = { run } matching run-agent.js
 */

'use strict';

const ai = require('../utils/aiProvider');
const { searchProducts } = require('../suppliers/aliexpress');
const { getShopifyClient } = require('../shopify/client');
const logger = require('../utils/logger');

const MAX_PRODUCTS_PER_RUN = parseInt(process.env.MAX_PRODUCTS_PER_RUN || '10');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const NICHE_BLACKLIST = [
  'fidget spinner', 'phone case generic', 'led strip lights', 'posture corrector',
];

// Simple in-process cache: niche → { products, timestamp }
const researchCache = new Map();

// ─── De-duplication ───────────────────────────────────────────────────────────

async function loadExistingSupplierUrls() {
  const shopify = getShopifyClient();
  const urls = new Set();

  try {
    // Read supplier_url metafields stored by the listing agent
    let page = await shopify.metafield.list({ namespace: 'custom', key: 'supplier_url', limit: 250 });
    page.forEach(m => urls.add(m.value));

    // shopify-api-node uses cursor-based pagination
    while (page.nextPageParameters) {
      page = await shopify.metafield.list({ ...page.nextPageParameters });
      page.forEach(m => urls.add(m.value));
    }
  } catch (err) {
    logger.warn(`[Research] Could not load existing supplier URLs: ${err.message}`);
  }

  logger.info(`[Research] ${urls.size} existing supplier URLs loaded for de-duplication`);
  return urls;
}

// ─── AI prompts ───────────────────────────────────────────────────────────────

async function generateNiches(blacklist) {
  return ai.chatJSON({
    system: 'You are a dropshipping product researcher. Respond ONLY with valid JSON.',
    prompt: `Identify 5 promising dropshipping product niches.
Requirements:
- High demand, not oversaturated
- Good margins (cost <$15, sell for $35+)
- Ships well (not fragile/liquid/oversized)
- Not seasonal

Skip these oversaturated niches: ${blacklist.join(', ')}

Return a JSON array of strings: ["niche 1", "niche 2", ...]`,
    maxTokens: 200,
  });
}

async function scoreProducts(products, niche) {
  const candidates = products.map(p => ({
    id: p.productId,
    title: p.title,
    price: p.price,
    orders: p.totalOrders,
    rating: p.rating,
    reviews: p.reviewCount,
  }));

  return ai.chatJSON({
    system: 'You evaluate AliExpress products for dropshipping. Respond ONLY with valid JSON.',
    prompt: `Score these products for the "${niche}" dropshipping niche (0–100).

Scoring criteria:
- Demand (orders, reviews): 30 pts
- Margin potential (low cost → high sell price): 25 pts
- Low competition (unique, not saturated): 20 pts
- Shipping feasibility (cheap/free shipping): 15 pts
- Visual appeal for product photos: 10 pts

Products:
${JSON.stringify(candidates, null, 2)}

Return a JSON array: [{"id":"...","score":75,"confidence":"high|medium|low","reason":"one sentence"}]`,
    maxTokens: 600,
  });
}

// ─── Core research ────────────────────────────────────────────────────────────

async function researchNiche(niche, existingUrls) {
  // Return cached results if fresh
  const cached = researchCache.get(niche);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.info(`[Research] Using cached results for "${niche}"`);
    return cached.products;
  }

  logger.info(`[Research] Searching: "${niche}"`);

  const rawProducts = await searchProducts(niche, {
    sortBy: 'orders', minRating: 4.0, maxPrice: 20, limit: 20,
  });

  if (!rawProducts.length) {
    logger.warn(`[Research] No products found for niche: ${niche}`);
    return [];
  }

  // Filter already-listed
  const newProducts = rawProducts.filter(p => !existingUrls.has(p.productUrl));
  logger.info(`[Research] ${rawProducts.length} found, ${newProducts.length} are new`);
  if (!newProducts.length) return [];

  // Score
  let scores = [];
  try {
    scores = await scoreProducts(newProducts, niche);
  } catch (err) {
    logger.warn(`[Research] Scoring failed for "${niche}": ${err.message}`);
    scores = newProducts.map(p => ({ id: p.productId, score: 50, confidence: 'low', reason: 'Scoring unavailable' }));
  }

  const scoreMap = Object.fromEntries(scores.map(s => [s.id, s]));

  const scored = newProducts
    .map(p => ({
      ...p,
      score: scoreMap[p.productId]?.score || 0,
      confidence: scoreMap[p.productId]?.confidence || 'low',
      scoreReason: scoreMap[p.productId]?.reason || '',
    }))
    .filter(p => p.score >= 60 && p.confidence !== 'low')
    .sort((a, b) => b.score - a.score);

  logger.info(`[Research] ${scored.length} products passed threshold for "${niche}"`);
  researchCache.set(niche, { products: scored, timestamp: Date.now() });
  return scored;
}

// ─── Agent class ──────────────────────────────────────────────────────────────

class ProductResearchAgent {
  constructor() {
    this.name = 'ProductResearchAgent';
  }

  /**
   * Main entry point — called by run-agent.js as: researchAgent.run()
   * Returns an array of scored products ready for the listing agent.
   */
  async run() {
    const startTime = Date.now();
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);

    const allProducts = [];

    try {
      const existingUrls = await loadExistingSupplierUrls();

      // Pick niches
      let niches;
      if (process.env.FIXED_NICHES) {
        niches = process.env.FIXED_NICHES.split(',').map(n => n.trim());
        logger.info(`[Research] Using fixed niches: ${niches.join(', ')}`);
      } else {
        niches = await generateNiches(NICHE_BLACKLIST);
        if (!Array.isArray(niches)) niches = ['portable blenders', 'pet accessories', 'home organisation'];
        logger.info(`[Research] AI selected niches: ${niches.join(', ')}`);
      }

      for (const niche of niches) {
        const products = await researchNiche(niche, existingUrls);
        products.forEach(p => {
          allProducts.push({ ...p, niche });
          existingUrls.add(p.productUrl); // prevent cross-niche duplicates
        });
      }

      const topProducts = allProducts
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_PRODUCTS_PER_RUN);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ ${this.name} complete in ${elapsed}s — ${topProducts.length} product(s) queued`);
      return topProducts;

    } catch (err) {
      logger.error(`[Research] Agent failed: ${err.message}`, { stack: err.stack });
      return allProducts; // Return what we have even on partial failure
    }
  }
}

module.exports = new ProductResearchAgent();
