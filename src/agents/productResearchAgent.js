const ai = require('../utils/aiProvider');
const { aliexpress, cjDropshipping } = require('../suppliers/aliexpress');
const logger = require('../utils/logger');

class ProductResearchAgent {
  constructor() {
    this.name = 'ProductResearchAgent';
    this.trendingSources = [
      'home decor', 'kitchen gadgets', 'phone accessories', 'fitness equipment',
      'pet supplies', 'beauty tools', 'car accessories', 'baby products',
      'office supplies', 'smart home', 'outdoor camping', 'garden tools',
    ];
  }

  async run() {
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);
    try {
      const niches = await this._identifyTrendingNiches();
      logger.info(`📊 Targeting niches: ${niches.join(', ')}`);

      const candidateProducts = await this._searchSuppliers(niches);
      logger.info(`🔍 Found ${candidateProducts.length} candidate products`);

      if (candidateProducts.length === 0) return [];

      const rankedProducts = await this._evaluateProducts(candidateProducts);
      logger.info(`⭐ Ranked ${rankedProducts.length} products by profitability`);

      const limit = parseInt(process.env.MAX_PRODUCTS_PER_RUN || 10);
      const topProducts = rankedProducts.slice(0, limit);
      logger.info(`✅ ${this.name} complete — ${topProducts.length} winning products`);
      return topProducts;
    } catch (error) {
      logger.error(`${this.name} failed`, { error: error.message });
      throw error;
    }
  }

  async _identifyTrendingNiches() {
    const month = new Date().toLocaleString('en', { month: 'long' });
    try {
      const result = await ai.chatJSON({
        system: `You are an expert e-commerce product researcher specialising in dropshipping profitability.`,
        prompt: `Based on current market trends for ${month}, identify the top 5 product niches with the highest dropshipping potential.
Consider: seasonal demand, impulse-buy appeal, low competition on Shopify, high perceived value, social media virality.
Return a JSON array of exactly 5 short search-friendly strings (2-4 words each):
["niche1", "niche2", "niche3", "niche4", "niche5"]`,
        maxTokens: 200,
      });
      return Array.isArray(result) && result.length >= 3
        ? result.slice(0, 5)
        : this.trendingSources.slice(0, 5);
    } catch (error) {
      logger.warn(`Niche identification failed, using defaults: ${error.message}`);
      return this.trendingSources.slice(0, 5);
    }
  }

  async _searchSuppliers(niches) {
    const allProducts = [];
    const maxPrice = parseFloat(process.env.MAX_PRICE_MULTIPLIER || 5) * 10;

    for (const niche of niches) {
      try {
        const aliProducts = await aliexpress.searchProducts(niche, { minSales: 100, maxPrice });
        if (aliProducts.length >= 3) {
          allProducts.push(...aliProducts);
        } else {
          // AliExpress returned nothing — fall back to CJ
          const cjProducts = await cjDropshipping.searchProducts(niche, { maxPrice });
          allProducts.push(...cjProducts);
        }
        await this._sleep(1000);
      } catch (error) {
        logger.warn(`Supplier search failed for niche "${niche}": ${error.message}`);
      }
    }

    // Deduplicate by product ID
    const seen = new Set();
    return allProducts.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }

  /**
   * Evaluate products in batches of 20 to avoid token overflow.
   * Each batch gets its own AI call, results are merged and re-sorted.
   */
  async _evaluateProducts(products) {
    if (products.length === 0) return [];

    const BATCH_SIZE = 20;
    const allEvaluations = [];
    const batches = this._chunk(products.slice(0, 80), BATCH_SIZE); // cap at 80 total

    logger.info(`🔬 Evaluating ${Math.min(products.length, 80)} products in ${batches.length} batches...`);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const productList = batch.map((p, i) => ({
        index: batchIdx * BATCH_SIZE + i,
        title: p.title,
        costPrice: p.price,
        sales: p.sales,
        rating: p.rating,
        shippingDays: p.shippingDays,
        supplier: p.supplierName,
      }));

      try {
        const evaluations = await ai.chatJSON({
          system: `You are a dropshipping profitability analyst. Score each product on: margin potential, demand signals, competition level, shipping speed, and social virality.`,
          prompt: `Evaluate these ${batch.length} products. Return the top 8 (or fewer if quality is low) as a JSON array.
Only include products with genuine profit potential (score ≥ 60).

Products:
${JSON.stringify(productList, null, 2)}

Return ONLY this JSON array (no markdown):
[
  {
    "index": <original index number>,
    "score": <1-100>,
    "reasoning": "<one concise sentence>",
    "suggestedMarkup": <number, e.g. 250>,
    "targetAudience": "<e.g. 'outdoor enthusiasts aged 25-45'>",
    "adAngle": "<e.g. 'solve the problem of X'>"
  }
]`,
          maxTokens: 1800,
        });

        if (Array.isArray(evaluations)) {
          allEvaluations.push(...evaluations);
          logger.info(`   Batch ${batchIdx + 1}/${batches.length}: ${evaluations.length} candidates`);
        }
      } catch (error) {
        logger.warn(`Evaluation batch ${batchIdx + 1} failed: ${error.message} — using sales ranking fallback`);
        // Fallback: pick top products from this batch by sales volume
        const fallback = batch
          .sort((a, b) => (b.sales || 0) - (a.sales || 0))
          .slice(0, 4)
          .map((_, localIdx) => ({
            index: batchIdx * BATCH_SIZE + localIdx,
            score: 55,
            suggestedMarkup: parseInt(process.env.DEFAULT_MARKUP_PERCENT || 200),
            targetAudience: 'general consumers',
            adAngle: 'quality and value',
          }));
        allEvaluations.push(...fallback);
      }

      // Brief pause between AI calls on large batches
      if (batchIdx < batches.length - 1) {
        await this._sleep(1500);
      }
    }

    // Map evaluations back to full product objects and sort by score
    return allEvaluations
      .filter(e => e.score >= 55 && products[e.index])
      .map(e => ({
        ...products[e.index],
        score: e.score,
        reasoning: e.reasoning,
        suggestedMarkup: e.suggestedMarkup || parseInt(process.env.DEFAULT_MARKUP_PERCENT || 200),
        targetAudience: e.targetAudience,
        adAngle: e.adAngle,
      }))
      .sort((a, b) => b.score - a.score);
  }

  _chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = new ProductResearchAgent();
