const ai = require('../utils/aiProvider');
const shopifyProducts = require('../shopify/products');
const { aliexpress } = require('../suppliers/aliexpress');
const logger = require('../utils/logger');

class PricingAgent {
  constructor() {
    this.name = 'PricingAgent';
  }

  async run() {
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);
    try {
      const products = await shopifyProducts.getAllDropshipProducts();
      logger.info(`💰 Checking prices for ${products.length} products`);
      const results = { updated: 0, skipped: 0, errors: 0 };

      for (const product of products) {
        try {
          const updated = await this._updateProductPrice(product);
          if (updated) results.updated++; else results.skipped++;
        } catch (error) {
          logger.warn(`Price update failed for ${product.id}`, { error: error.message });
          results.errors++;
        }
        await this._sleep(500);
      }

      logger.info(`✅ ${this.name} complete:`, results);
      return results;
    } catch (error) {
      logger.error(`${this.name} failed`, { error: error.message });
      throw error;
    }
  }

  async _updateProductPrice(product) {
    const metafields = await shopifyProducts.getProductMetafields(product.id);
    const supplierId = metafields.find(m => m.key === 'supplier_id')?.value;
    const storedCost = parseFloat(metafields.find(m => m.key === 'cost_price')?.value || 0);
    const supplierName = metafields.find(m => m.key === 'supplier_name')?.value || 'AliExpress';

    if (!supplierId) return false;

    let currentCost = storedCost;
    try {
      const supplierProduct = await aliexpress.getProductDetails(supplierId);
      if (supplierProduct?.price) currentCost = supplierProduct.price;
    } catch (_) {}

    if (currentCost <= 0) return false;

    const pricingDecision = await this._getPricingDecision({ product, currentCost, storedCost, supplierName });

    if (!pricingDecision.shouldUpdate) return false;

    for (const variant of product.variants) {
      await shopifyProducts.updateVariantPrice(variant.id, pricingDecision.newPrice, pricingDecision.comparePrice);
    }

    if (Math.abs(currentCost - storedCost) > 0.5) {
      await this._updateCostMetafield(product.id, currentCost);
    }

    logger.info(`💰 Updated "${product.title}": $${product.variants[0]?.price} → $${pricingDecision.newPrice}`);
    return true;
  }

  async _getPricingDecision({ product, currentCost, storedCost, supplierName }) {
    const currentPrice = parseFloat(product.variants[0]?.price || 0);
    const minMargin = parseFloat(process.env.MIN_PROFIT_MARGIN || 30);
    const shippingBuffer = parseFloat(process.env.SHIPPING_BUFFER || 5);
    const minPrice = (currentCost + shippingBuffer) / (1 - minMargin / 100);
    const costChanged = Math.abs(currentCost - storedCost) > 0.5;

    if (!costChanged && currentPrice >= minPrice) return { shouldUpdate: false };

    try {
      const decision = await ai.chatJSON({
        system: `You are a dropshipping pricing expert. Analyze cost changes and recommend optimal prices.`,
        prompt: `Pricing analysis:

Product: "${product.title}"
Supplier: ${supplierName}
Supplier cost: $${currentCost.toFixed(2)} (was $${storedCost.toFixed(2)})
Current selling price: $${currentPrice.toFixed(2)}
Minimum viable price: $${minPrice.toFixed(2)}
Shipping buffer: $${shippingBuffer}
Target margin: ${minMargin}%+

Should we update the price? Use psychological pricing (x.99).

Return: { "shouldUpdate": true/false, "newPrice": 0.00, "comparePrice": 0.00, "reasoning": "..." }`,
        maxTokens: 400
      });

      if (decision.newPrice < minPrice) {
        decision.newPrice = parseFloat((Math.ceil(minPrice) - 0.01).toFixed(2));
        decision.comparePrice = parseFloat((decision.newPrice * 1.4).toFixed(2));
      }
      return decision;
    } catch (error) {
      logger.warn('AI pricing decision failed, using formula');
      if (currentPrice < minPrice || costChanged) {
        const markup = parseFloat(process.env.DEFAULT_MARKUP_PERCENT || 200);
        const rawPrice = (currentCost + shippingBuffer) * (1 + markup / 100);
        const newPrice = parseFloat((Math.ceil(rawPrice) - 0.01).toFixed(2));
        return { shouldUpdate: true, newPrice, comparePrice: parseFloat((newPrice * 1.4).toFixed(2)) };
      }
      return { shouldUpdate: false };
    }
  }

  async _updateCostMetafield(productId, newCost) {
    try {
      const { getShopifyClient } = require('../shopify/client');
      const shopify = getShopifyClient();
      const metafields = await shopify.metafield.list({ metafield: { owner_resource: 'product', owner_id: productId } });
      const costMeta = metafields.find(m => m.namespace === 'dropship' && m.key === 'cost_price');
      if (costMeta) await shopify.metafield.update(costMeta.id, { value: String(newCost) });
    } catch (_) {}
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = new PricingAgent();
