/**
 * productResearchAgent.js — Improved Product Research Agent
 *
 * Improvements over original:
 *  1. Supplier URL de-duplication — skips products already in your store
 *  2. Improved AI scoring prompt — now scores competition & saturation
 *  3. Niche blacklist — skip oversaturated categories
 *  4. Result caching — don't re-research the same niche within 24h
 *  5. Agent status registry updates
 *  6. Structured output with confidence scores for each product
 */

import { getAIClient } from '../utils/aiProvider.js';
import { searchProducts } from '../suppliers/aliexpress.js';
import { shopifyClient } from '../shopify/client.js';
import { agentRegistry } from '../utils/agentRegistry.js';
import logger from '../utils/logger.js';

const AGENT_NAME = 'research';
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_PRODUCTS_PER_RUN = parseInt(process.env.MAX_PRODUCTS_PER_RUN ?? '10');

// Categories that are oversaturated — AI can add to this dynamically
const NICHE_BLACKLIST = [
  'fidget spinner',
  'phone case generic',
  'led strip lights',
  'posture corrector',
];

// Simple in-process cache: niche → { products, timestamp }
const researchCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── De-duplication ───────────────────────────────────────────────────────────

/**
 * Load the set of supplier URLs already listed in the store.
 * Uses Shopify's metafield search — O(1) per product check.
 */
async function loadExistingSupplierUrls() {
  const urls = new Set();
  let sinceId = null;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      namespace: 'custom',
      key: 'supplier_url',
      limit: '250',
      ...(sinceId ? { since_id: sinceId } : {}),
    });

    const res = await shopifyClient.get(`/metafields.json?${params}`);
    const metafields = res.data.metafields ?? [];

    metafields.forEach(m => urls.add(m.value));
    hasMore = metafields.length === 250;
    sinceId = metafields[metafields.length - 1]?.id;
  }

  logger.info(`[Research] Loaded ${urls.size} existing supplier URLs for de-duplication`);
  return urls;
}

// ─── AI prompts ───────────────────────────────────────────────────────────────

/**
 * Ask AI to identify trending niches to research.
 */
async function generateNichesToResearch(ai, blacklist) {
  const prompt = `You are a dropshipping product researcher. Identify 5 promising product niches to research right now.

Requirements:
- High demand but not oversaturated
- Good dropship margins (cost under $15, sell for $35+)
- Not seasonal/one-time trends
- Ships well (no fragile/liquid/large items)
- Appeals to broad online audiences

Blacklisted (skip these): ${blacklist.join(', ')}

Return ONLY a JSON array of niche strings, e.g.:
["portable blenders", "cat enrichment toys", "posture support cushions"]
No explanation.`;

  const res = await ai.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
  } catch {
    return ['portable blenders', 'pet accessories', 'home organisation'];
  }
}

/**
 * Score a list of candidate products with richer criteria.
 */
async function scoreProducts(ai, products, niche) {
  const candidates = products.map(p => ({
    id: p.productId,
    title: p.title,
    price: p.price,
    orders: p.totalOrders,
    rating: p.rating,
    reviewCount: p.reviewCount,
    shipping: p.shippingOptions?.[0]?.price ?? 0,
  }));

  const prompt = `You are evaluating AliExpress products for a dropship store in the "${niche}" niche.

Score each product 0–100 based on:
- Demand signals (orders, reviews): 30 pts
- Margin potential (sell price vs AliExpress cost): 25 pts  
- Low competition on Shopify (unique, not everywhere already): 20 pts
- Shipping feasibility (free or cheap, not too heavy): 15 pts
- Visual appeal for product photos: 10 pts

Products to score:
${JSON.stringify(candidates, null, 2)}

Return ONLY a JSON array:
[{ "id": "...", "score": 75, "confidence": "high|medium|low", "reason": "one sentence" }]`;

  const res = await ai.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
  } catch {
    return candidates.map(c => ({ id: c.id, score: 50, confidence: 'low', reason: 'Scoring failed' }));
  }
}

// ─── Core research logic ──────────────────────────────────────────────────────

async function researchNiche(ai, niche, existingUrls) {
  // Check cache
  const cached = researchCache.get(niche);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.info(`[Research] Using cached results for "${niche}"`);
    return cached.products;
  }

  logger.info(`[Research] Searching AliExpress for: "${niche}"`);

  // Search AliExpress for candidates
  const rawProducts = await searchProducts(niche, {
    sortBy: 'orders',
    minRating: 4.0,
    maxPrice: 20, // Max cost $20 to maintain margins
    limit: 20,
  });

  if (!rawProducts?.length) {
    logger.warn(`[Research] No products found for niche: ${niche}`);
    return [];
  }

  // Filter already-listed products
  const newProducts = rawProducts.filter(p => !existingUrls.has(p.productUrl));
  logger.info(`[Research] ${rawProducts.length} found, ${newProducts.length} are new`);

  if (newProducts.length === 0) return [];

  // Score remaining candidates
  const scores = await scoreProducts(ai, newProducts, niche);
  const scoreMap = Object.fromEntries(scores.map(s => [s.id, s]));

  // Merge score data back into products and filter low-confidence
  const scored = newProducts
    .map(p => ({
      ...p,
      score: scoreMap[p.productId]?.score ?? 0,
      confidence: scoreMap[p.productId]?.confidence ?? 'low',
      scoreReason: scoreMap[p.productId]?.reason ?? '',
    }))
    .filter(p => p.score >= 60 && p.confidence !== 'low')
    .sort((a, b) => b.score - a.score);

  logger.info(`[Research] ${scored.length} products passed scoring threshold (≥60, not low confidence)`);

  // Cache results
  researchCache.set(niche, { products: scored, timestamp: Date.now() });

  return scored;
}

// ─── Agent runner ─────────────────────────────────────────────────────────────

export async function runResearchAgent() {
  const startTime = Date.now();
  agentRegistry.update(AGENT_NAME, { status: 'running', lastRun: new Date().toISOString() });

  const ai = getAIClient();
  const allProducts = [];

  try {
    // Load existing store products for de-duplication
    const existingUrls = await loadExistingSupplierUrls();

    // Determine niches to research
    let niches;
    if (process.env.FIXED_NICHES) {
      niches = process.env.FIXED_NICHES.split(',').map(n => n.trim());
      logger.info(`[Research] Using fixed niches from env: ${niches.join(', ')}`);
    } else {
      niches = await generateNichesToResearch(ai, NICHE_BLACKLIST);
      logger.info(`[Research] AI selected niches: ${niches.join(', ')}`);
    }

    // Research each niche
    for (const niche of niches) {
      const products = await researchNiche(ai, niche, existingUrls);
      allProducts.push(...products.map(p => ({ ...p, niche })));

      // Add newly found supplier URLs to the set to prevent cross-niche duplicates
      products.forEach(p => existingUrls.add(p.productUrl));
    }

    // Return top N by score across all niches
    const topProducts = allProducts
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PRODUCTS_PER_RUN);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[Research] Done in ${duration}s — ${topProducts.length} products queued for listing`);

    agentRegistry.update(AGENT_NAME, {
      status: 'idle',
      lastRun: new Date().toISOString(),
      lastStats: {
        nichesResearched: niches.length,
        productsFound: allProducts.length,
        productsQueued: topProducts.length,
      },
    });

    return topProducts;
  } catch (err) {
    logger.error(`[Research] Agent run failed: ${err.message}`);
    agentRegistry.update(AGENT_NAME, { status: 'error', lastError: err.message });
    return [];
  }
}

export function startResearchAgent(onProductsFound) {
  const run = async () => {
    const products = await runResearchAgent();
    if (products.length > 0 && onProductsFound) {
      await onProductsFound(products);
    }
  };

  run();
  setInterval(run, POLL_INTERVAL_MS);
  logger.info('[Research] Agent started — running every 6 hours');
}
