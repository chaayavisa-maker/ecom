const ai = require('../utils/aiProvider');
const shopifyProducts = require('../shopify/products');
const { aliexpress } = require('../suppliers/aliexpress');
const logger = require('../utils/logger');

class InventoryAgent {
  constructor() {
    this.name = 'InventoryAgent';
    this.LOW_STOCK_THRESHOLD = 5;
  }

  async run() {
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);
    try {
      const products = await shopifyProducts.getAllDropshipProducts();
      const locations = await shopifyProducts.getLocations();
      if (locations.length === 0) { logger.error('No Shopify locations found'); return; }

      const locationId = locations[0].id;
      const results = { synced: 0, outOfStock: 0, errors: 0 };

      for (const product of products) {
        try {
          const updated = await this._syncProductInventory(product, locationId);
          if (updated.outOfStock) { results.outOfStock++; await this._handleOutOfStock(product); }
          results.synced++;
        } catch (error) {
          logger.warn(`Inventory sync failed for ${product.id}`, { error: error.message });
          results.errors++;
        }
        await this._sleep(1000);
      }

      logger.info(`✅ ${this.name} complete:`, results);
      return results;
    } catch (error) {
      logger.error(`${this.name} failed`, { error: error.message });
      throw error;
    }
  }

  async _syncProductInventory(product, locationId) {
    const metafields = await shopifyProducts.getProductMetafields(product.id);
    const supplierId = metafields.find(m => m.key === 'supplier_id')?.value;
    if (!supplierId) return { synced: false };

    let supplierStock = await this._getSupplierStock(supplierId);
    const stockDecision = await this._getStockDecision(product, supplierStock);

    for (const variant of product.variants) {
      if (variant.inventory_item_id) {
        await shopifyProducts.updateInventory(variant.inventory_item_id, locationId, stockDecision.quantity);
      }
    }

    const isOutOfStock = stockDecision.quantity <= 0;
    if (isOutOfStock) logger.warn(`⚠️ "${product.title}" is out of stock`);
    else if (stockDecision.quantity <= this.LOW_STOCK_THRESHOLD) logger.warn(`📉 Low stock: "${product.title}" — ${stockDecision.quantity} units`);

    return { synced: true, outOfStock: isOutOfStock, quantity: stockDecision.quantity };
  }

  async _getSupplierStock(supplierId) {
    try {
      const product = await aliexpress.getProductDetails(supplierId);
      if (!product) return { available: false, quantity: 0 };
      return { available: true, quantity: 99, price: product.price };
    } catch (_) {
      return { available: true, quantity: 50 };
    }
  }

  async _getStockDecision(product, supplierStock) {
    if (!supplierStock.available) return { quantity: 0, action: 'out_of_stock' };
    try {
      const decision = await ai.chatJSON({
        system: `You are an inventory management AI for dropshipping. Make stock quantity decisions.`,
        prompt: `Product: "${product.title}"
Supplier stock available: ${supplierStock.available}
Supplier quantity estimate: ${supplierStock.quantity}

What quantity should we show in Shopify? (max 50 for dropshipping — don't inflate artificially)
Return: { "quantity": 0, "reasoning": "..." }`,
        maxTokens: 200
      });
      return { quantity: Math.min(Math.max(0, decision.quantity), 99), action: 'in_stock' };
    } catch (_) {
      return { quantity: supplierStock.available ? Math.min(supplierStock.quantity, 50) : 0, action: supplierStock.available ? 'in_stock' : 'out_of_stock' };
    }
  }

  async _handleOutOfStock(product) {
    try {
      await shopifyProducts.updateProduct(product.id, { status: 'draft' });
      logger.info(`🚫 "${product.title}" drafted (out of stock)`);
      await this._sendAlert(`📦 Out of Stock: "${product.title}" has been drafted. Please find a replacement.`);
    } catch (error) {
      logger.error(`Failed to handle out-of-stock for ${product.id}`, { error: error.message });
    }
  }

  async _sendAlert(message) {
    if (process.env.SLACK_WEBHOOK_URL) {
      try {
        const axios = require('axios');
        await axios.post(process.env.SLACK_WEBHOOK_URL, { text: message });
      } catch (_) {}
    }
    logger.warn(`ALERT: ${message}`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = new InventoryAgent();
