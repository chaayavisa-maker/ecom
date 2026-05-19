const ai = require('../utils/aiProvider');
const { aliexpress, cjDropshipping } = require('../suppliers/aliexpress');
const logger = require('../utils/logger');

class ProductResearchAgent {
  constructor() {
    this.name = 'ProductResearchAgent';
    this.trendingSources = [
      'home decor', 'kitchen gadgets', 'phone accessories', 'fitness equipment',
      'pet supplies', 'beauty tools', 'car accessories', 'baby products',
      'office supplies', 'smart home', 'outdoor camping', 'garden tools'
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
      const topProducts = rankedProducts.slice(0, parseInt(process.env.MAX_PRODUCTS_PER_RUN || 10));
      logger.info(`✅ ${this.name} complete — ${topProducts.length} winning products`);
      return topProducts;
    } catch (error) {
      logger.error(`${this.name} failed`, { error: error.message });
      throw error;
    }
  }

  async _identifyTrendingNiches() {
    try {
      const result = await ai.chatJSON({
        system: `You are an expert e-commerce product researcher specializing in dropshipping.
Identify high-potential product niches that are currently trending and profitable.`,
        prompt: `Based on current market trends, identify the top 5 product niches with HIGH dropshipping potential.
Consider: seasonality (${new Date().toLocaleString('en', { month: 'long' })}), impulse-buy potential, low competition, high perceived value, virality.
Return a JSON array of 5 strings: ["niche1", "niche2", "niche3", "niche4", "niche5"]`,
        maxTokens: 300
      });
      return Array.isArray(result) ? result : this.trendingSources.slice(0, 5);
    } catch (error) {
      logger.warn('Niche identification failed, using defaults');
      return this.trendingSources.slice(0, 5);
    }
  }

  async _searchSuppliers(niches) {
    const allProducts = [];
    const maxPrice = parseFloat(process.env.MAX_PRICE_MULTIPLIER || 5) * 10;
    for (const niche of niches) {
      try {
        const aliProducts = await aliexpress.searchProducts(niche, { minSales: 100, maxPrice });
        allProducts.push(...aliProducts);
        if (aliProducts.length < 3) {
          const cjProducts = await cjDropshipping.searchProducts(niche, { maxPrice });
          allProducts.push(...cjProducts);
        }
        await this._sleep(1000);
      } catch (error) {
        logger.warn(`Supplier search failed for niche: ${niche}`);
      }
    }
    const seen = new Set();
    return allProducts.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  }

  async _evaluateProducts(products) {
    if (products.length === 0) return [];
    const productList = products.slice(0, 50).map((p, i) => ({
      index: i, title: p.title, costPrice: p.price, sales: p.sales,
      rating: p.rating, shippingDays: p.shippingDays, supplier: p.supplierName
    }));
    try {
      const evaluations = await ai.chatJSON({
        system: `You are a dropshipping profitability analyst. Score each product 1-100 for: margin potential, demand, competition, shipping speed, virality.`,
        prompt: `Evaluate these products and return the top 15 as a JSON array.
Products: ${JSON.stringify(productList, null, 2)}
Each item: { "index": N, "score": N, "reasoning": "...", "suggestedMarkup": N, "targetAudience": "...", "adAngle": "..." }`,
        maxTokens: 2000
      });
      return evaluations
        .filter(e => e.score >= 50)
        .map(e => ({
          ...products[e.index],
          score: e.score,
          reasoning: e.reasoning,
          suggestedMarkup: e.suggestedMarkup || parseInt(process.env.DEFAULT_MARKUP_PERCENT || 200),
          targetAudience: e.targetAudience,
          adAngle: e.adAngle
        }))
        .sort((a, b) => b.score - a.score);
    } catch (error) {
      logger.error('Product evaluation failed', { error: error.message });
      return products.sort((a, b) => b.sales - a.sales).slice(0, 15)
        .map(p => ({ ...p, score: 50, suggestedMarkup: parseInt(process.env.DEFAULT_MARKUP_PERCENT || 200) }));
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = new ProductResearchAgent();
