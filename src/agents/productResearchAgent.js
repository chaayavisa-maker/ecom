/**
 * productResearchAgent.js — Product Research Agent
 *
 * Niche selection now follows a 3-step priority:
 *   1. Approved niches from niche.config.json  → used immediately
 *   2. No approved niches yet                  → AI generates suggestions,
 *      saves them as 'pending', logs prompt to run `npm run niches`
 *   3. While awaiting first approval           → falls back to safe defaults
 *
 * Other fixes retained from previous version:
 *   - AI scoring fallback (score:65) so pipeline never stalls
 *   - De-dup handles Shopify 402 / plan limits gracefully
 *   - Exports .run() for compatibility with run-agent.js
 */

'use strict';

const ai          = require('../utils/aiProvider');
const nicheConfig = require('../config/niches');
const { searchProducts }       = require('../suppliers/aliexpress');
const { getShopifyClient }     = require('../shopify/client');
const logger = require('../utils/logger');

const MAX_PRODUCTS_PER_RUN = parseInt(process.env.MAX_PRODUCTS_PER_RUN || '10', 10);
const CACHE_TTL_MS         = 24 * 60 * 60 * 1000;
const IS_MOCK_MODE         = !process.env.ALIEXPRESS_APP_KEY;

// Score threshold: be lenient in mock/dev mode
const SCORE_THRESHOLD = IS_MOCK_MODE ? 0 : 60;

// Built-in fallback niches used only while awaiting first approval
const DEFAULT_NICHES = ['portable blenders', 'pet accessories', 'desk organisers'];

// These are passed to the AI to avoid suggesting oversaturated products.
// Rejected niches from niche.config.json are added automatically at runtime.
const STATIC_BLACKLIST = [
  'fidget spinner', 'phone case generic', 'led strip lights', 'posture corrector',
];

const researchCache = new Map();

// ─── De-duplication ───────────────────────────────────────────────────────────

async function loadExistingSupplierUrls() {
  if (IS_MOCK_MODE) return new Set();

  const shopify = getShopifyClient();
  const urls    = new Set();

  try {
    const page = await shopify.product.list({ limit: 250, fields: 'id,metafields' });
    for (const product of page) {
      for (const mf of (product.metafields || [])) {
        if (mf.namespace === 'custom' && mf.key === 'supplier_url') {
          urls.add(mf.value);
        }
      }
    }
  } catch (err) {
    logger.warn(`[Research] De-duplication skipped: ${err.message}`);
  }

  logger.info(`[Research] ${urls.size} existing supplier URLs loaded`);
  return urls;
}

// ─── AI helpers ───────────────────────────────────────────────────────────────

async function generateNiches(blacklist) {
  const result = await ai.chatJSON({
    system: 'You are a dropshipping product researcher. Respond ONLY with a valid JSON array of strings.',
    prompt: `Identify 5 promising dropshipping product niches for 2025.
Requirements: high demand, not oversaturated, margins >200%, ships easily, not seasonal, good repeat-buy potential.
Skip these (too saturated or blacklisted): ${blacklist.join(', ')}
Return ONLY: ["niche 1", "niche 2", "niche 3", "niche 4", "niche 5"]`,
    maxTokens: 150,
  });

  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('AI returned empty niche list');
  }
  return result;
}

async function scoreProducts(products, niche) {
  const candidates = products.map(p => ({
    id:      p.productId,
    title:   p.title,
    price:   p.price,
    orders:  p.totalOrders,
    rating:  p.rating,
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

// ─── Niche selection ──────────────────────────────────────────────────────────

async function selectNiches() {
  // 1. Use niches you've already approved
  const approved = nicheConfig.getApprovedNiches();
  if (approved.length > 0) {
    logger.info(`[Research] ✅ Using ${approved.length} approved niche(s): ${approved.join(', ')}`);
    return approved;
  }

  // 2. No approved niches — ask AI for suggestions and queue them for review
  const expiredNiches = nicheConfig.getExpiredNiches();
  if (expiredNiches.length > 0) {
    logger.info(`[Research] Previous niches have expired: ${expiredNiches.join(', ')}`);
  }

  const rejectedNames   = nicheConfig.getRejectedNames();
  const fullBlacklist   = [...STATIC_BLACKLIST, ...rejectedNames];

  if (!nicheConfig.hasPendingNiches()) {
    // Generate and queue new suggestions
    try {
      const suggestions = await generateNiches(fullBlacklist);
      const added = nicheConfig.savePendingNiches(suggestions);
      logger.info(`[Research] 💡 AI suggested ${added} niche(s) — run \`npm run niches\` to approve them`);
      logger.info(`[Research]    Suggestions: ${suggestions.join(', ')}`);
    } catch (err) {
      logger.warn(`[Research] Niche suggestion failed: ${err.message}`);
    }
  } else {
    const pendingCount = nicheConfig.getPendingNiches().length;
    logger.warn(`[Research] ⏳ ${pendingCount} niche suggestion(s) still pending — run \`npm run niches\` to approve`);
  }

  // 3. Nothing approved yet — use safe defaults so the pipeline keeps running
  logger.warn(`[Research] Using default niches while awaiting approval: ${DEFAULT_NICHES.join(', ')}`);
  return DEFAULT_NICHES;
}

// ─── Core research ────────────────────────────────────────────────────────────

async function researchNiche(niche, existingUrls) {
  const cached = researchCache.get(niche);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.info(`[Research] Cache hit for "${niche}"`);
    return cached.products;
  }

  logger.info(`[Research] Searching: "${niche}"`);
  const rawProducts = await searchProducts(niche, {
    sortBy: 'orders', minRating: 4.0, maxPrice: 20, limit: 20,
  });

  if (!rawProducts || rawProducts.length === 0) {
    logger.warn(`[Research] No products returned for: ${niche}`);
    return [];
  }

  const newProducts = rawProducts.filter(p => !existingUrls.has(p.productUrl || p.supplierUrl));
  logger.info(`[Research] ${rawProducts.length} found, ${newProducts.length} new for "${niche}"`);
  if (!newProducts.length) return [];

  // AI scoring with fallback so the pipeline never stalls
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
    logger.warn(`[Research] AI scoring fell back to defaults for "${niche}": ${err.message}`);
    scoreMap = Object.fromEntries(
      newProducts.map(p => [p.productId, {
        id:         p.productId,
        score:      65,
        confidence: 'medium',
        reason:     'AI scoring unavailable — default pass score',
      }])
    );
  }

  const scored = newProducts
    .map(p => ({
      ...p,
      score:       scoreMap[p.productId]?.score      || 65,
      confidence:  scoreMap[p.productId]?.confidence || 'medium',
      scoreReason: scoreMap[p.productId]?.reason     || '',
    }))
    .filter(p => p.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  logger.info(`[Research] ${scored.length} product(s) passed threshold (>=${SCORE_THRESHOLD}) for "${niche}"`);
  researchCache.set(niche, { products: scored, timestamp: Date.now() });
  return scored;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

class ProductResearchAgent {
  constructor() {
    this.name = 'ProductResearchAgent';
  }

  async run() {
    const startTime = Date.now();

    if (IS_MOCK_MODE) {
      logger.warn('🔧 [Research] MOCK MODE — set ALIEXPRESS_APP_KEY for live products');
    }
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);

    const allProducts = [];

    try {
      const [existingUrls, niches] = await Promise.all([
        loadExistingSupplierUrls(),
        selectNiches(),
      ]);

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
      logger.info(`✅ ${this.name} done in ${elapsed}s — ${topProducts.length} product(s) queued for listing`);

      return topProducts;

    } catch (err) {
      logger.error(`[Research] Agent failed: ${err.message}`, { stack: err.stack });
      return allProducts;
    }
  }
}

module.exports = new ProductResearchAgent();
