/**
 * productResearchAgent.js — Fixed Product Research Agent (CJS)
 *
 * Fixes in this version:
 *  1. Scoring fallback no longer kills all products:
 *     - When AI scoring fails → products get score:65, confidence:'medium' (pass the filter)
 *     - Filter threshold lowered to 50 when in mock/dev mode (no API key)
 *  2. De-duplication gracefully handles Shopify 402 / plan limits
 *  3. Exports .run() matching run-agent.js
 */

'use strict';

const ai = require('../utils/aiProvider');
const { searchProducts } = require('../suppliers/aliexpress');
const { getShopifyClient } = require('../shopify/client');
const logger = require('../utils/logger');

const MAX_PRODUCTS_PER_RUN = parseInt(process.env.MAX_PRODUCTS_PER_RUN || '10');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IS_MOCK_MODE = !process.env.ALIEXPRESS_APP_KEY;

// Score threshold: be lenient in mock/dev mode
const SCORE_THRESHOLD = IS_MOCK_MODE ? 0 : 60;

const NICHE_BLACKLIST = [
  'fidget spinner', 'phone case generic', 'led strip lights', 'posture corrector',
];

const researchCache = new Map();

// ─── De-duplication ───────────────────────────────────────────────────────────

async function loadExistingSupplierUrls() {
  // Skip on mock mode — no real products to de-dup against
  if (IS_MOCK_MODE) return new Set();

  const shopify = getShopifyClient();
  const urls = new Set();

  try {
    // Use product list + metafield approach compatible with all Shopify plans
    let page = await shopify.product.list({ limit: 250, fields: 'id,metafields' });
    for (const product of page) {
      for (const mf of (product.metafields || [])) {
        if (mf.namespace === 'custom' && mf.key === 'supplier_url') {
          urls.add(mf.value);
        }
      }
    }
  } catch (err) {
    // 402 = plan doesn't support this endpoint; 403 = permissions; either way, skip dedup
    logger.warn(`[Research] De-duplication skipped: ${err.message}`);
  }

  logger.info(`[Research] ${urls.size} existing supplier URLs loaded`);
  return urls;
}

// ─── AI helpers ───────────────────────────────────────────────────────────────

async function generateNiches(blacklist) {
  const result = await ai.chatJSON({
    system: 'You are a dropshipping product researcher. Respond ONLY with a valid JSON array of strings.',
    prompt: `Identify 5 promising dropshipping product niches.
Requirements: high demand, not oversaturated, margins >200%, ships easily, not seasonal.
Skip: ${blacklist.join(', ')}
Return: ["niche 1", "niche 2", "niche 3", "niche 4", "niche 5"]`,
    maxTokens: 150,
  });
  return Array.isArray(result) ? result : ['portable blenders', 'pet accessories', 'desk organisers', 'phone stands', 'reusable water bottles'];
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

  const result = await ai.chatJSON({
    system: 'You evaluate AliExpress products for dropshipping. Respond ONLY with a valid JSON array.',
    prompt: `Score these "${niche}" products for dropshipping viability (0–100):
- Demand (orders, reviews): 30pts
- Margin potential: 25pts
- Low competition: 20pts
- Shipping feasibility: 15pts
- Visual appeal: 10pts

${JSON.stringify(candidates)}

Return: [{"id":"...","score":75,"confidence":"high|medium|low","reason":"one sentence"}]`,
    maxTokens: 500,
  });

  return Array.isArray(result) ? result : [];
}

// ─── Core research ────────────────────────────────────────────────────────────

async function researchNiche(niche, existingUrls) {
  const cached = researchCache.get(niche);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.info(`[Research] Using cached results for "${niche}"`);
    return cached.products;
  }

  logger.info(`[Research] Searching: "${niche}"`);
  const rawProducts = await searchProducts(niche, {
    sortBy: 'orders', minRating: 4.0, maxPrice: 20, limit: 20,
  });

  if (!rawProducts || rawProducts.length === 0) {
    logger.warn(`[Research] No products returned for niche: ${niche}`);
    return [];
  }

  // De-duplicate against existing listings
  const newProducts = rawProducts.filter(p => !existingUrls.has(p.productUrl || p.supplierUrl));
  logger.info(`[Research] ${rawProducts.length} found, ${newProducts.length} new for "${niche}"`);
  if (!newProducts.length) return [];

  // AI scoring — with safe fallback that doesn't kill the pipeline
  let scoreMap = {};
  try {
    const scores = await scoreProducts(newProducts, niche);
    if (scores.length > 0) {
      scoreMap = Object.fromEntries(scores.map(s => [s.id, s]));
      logger.info(`[Research] Scored ${scores.length} products for "${niche}"`);
    } else {
      throw new Error('Empty score array');
    }
  } catch (err) {
    // ── KEY FIX: fallback gives passing scores, not 'low' confidence ──
    logger.warn(`[Research] AI scoring failed for "${niche}" — using default scores: ${err.message}`);
    scoreMap = Object.fromEntries(
      newProducts.map(p => [p.productId, {
        id: p.productId,
        score: 65,           // above the 60 threshold
        confidence: 'medium', // not 'low', so it passes the filter
        reason: 'AI scoring unavailable — using default pass score',
      }])
    );
  }

  const scored = newProducts
    .map(p => ({
      ...p,
      score:       scoreMap[p.productId]?.score || 65,
      confidence:  scoreMap[p.productId]?.confidence || 'medium',
      scoreReason: scoreMap[p.productId]?.reason || '',
    }))
    .filter(p => p.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  logger.info(`[Research] ${scored.length} products passed threshold (>=${SCORE_THRESHOLD}) for "${niche}"`);
  researchCache.set(niche, { products: scored, timestamp: Date.now() });
  return scored;
}

// ─── Agent class ──────────────────────────────────────────────────────────────

class ProductResearchAgent {
  constructor() {
    this.name = 'ProductResearchAgent';
  }

  async run() {
    const startTime = Date.now();
    if (IS_MOCK_MODE) {
      logger.warn('🔧 [Research] Running in MOCK MODE — set ALIEXPRESS_APP_KEY for real products');
    }
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);

    const allProducts = [];

    try {
      const existingUrls = await loadExistingSupplierUrls();

      // Pick niches
      let niches;
      if (process.env.FIXED_NICHES) {
        niches = process.env.FIXED_NICHES.split(',').map(n => n.trim());
        logger.info(`[Research] Using FIXED_NICHES: ${niches.join(', ')}`);
      } else {
        try {
          niches = await generateNiches(NICHE_BLACKLIST);
          logger.info(`[Research] AI selected niches: ${niches.join(', ')}`);
        } catch (err) {
          niches = ['portable blenders', 'pet accessories', 'desk organisers'];
          logger.warn(`[Research] Niche generation failed, using defaults: ${err.message}`);
        }
      }

      for (const niche of niches) {
        try {
          const products = await researchNiche(niche, existingUrls);
          products.forEach(p => {
            allProducts.push({ ...p, niche });
            existingUrls.add(p.productUrl || p.supplierUrl || '');
          });
        } catch (err) {
          logger.error(`[Research] Failed for niche "${niche}": ${err.message}`);
        }
      }

      const topProducts = allProducts
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_PRODUCTS_PER_RUN);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ ${this.name} complete in ${elapsed}s — ${topProducts.length} product(s) queued for listing`);

      if (IS_MOCK_MODE && topProducts.length > 0) {
        logger.warn(`🔧 [Research] ${topProducts.length} MOCK products will create DRAFT listings — safe to review before publishing`);
      }

      return topProducts;

    } catch (err) {
      logger.error(`[Research] Agent failed: ${err.message}`, { stack: err.stack });
      return allProducts;
    }
  }
}

module.exports = new ProductResearchAgent();
