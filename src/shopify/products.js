const { getShopifyClient } = require('./client');
const logger = require('../utils/logger');

class ShopifyProducts {
  constructor() {
    this.shopify = getShopifyClient();
  }

  /**
   * Create a product on Shopify with full variant + image support
   */
  async createProduct(productData) {
    try {
      const shopifyProduct = {
        title: productData.title,
        body_html: productData.description,
        vendor: productData.vendor || 'Dropship Store',
        product_type: productData.category || '',
        tags: productData.tags?.join(', ') || '',
        status: process.env.AUTO_PUBLISH_PRODUCTS === 'true' ? 'active' : 'draft',
        variants: this._buildVariants(productData),
        images: productData.images?.map((src, i) => ({
          src,
          position: i + 1,
          alt: productData.title
        })) || [],
        metafields: [
          {
            namespace: 'dropship',
            key: 'supplier_id',
            value: String(productData.supplierId || ''),
            type: 'single_line_text_field'
          },
          {
            namespace: 'dropship',
            key: 'supplier_url',
            value: productData.supplierUrl || '',
            type: 'single_line_text_field'
          },
          {
            namespace: 'dropship',
            key: 'cost_price',
            value: String(productData.costPrice || 0),
            type: 'single_line_text_field'
          },
          {
            namespace: 'dropship',
            key: 'supplier_name',
            value: productData.supplierName || 'AliExpress',
            type: 'single_line_text_field'
          }
        ]
      };

      const created = await this.shopify.product.create(shopifyProduct);
      logger.info(`✅ Product created: "${created.title}" (ID: ${created.id})`);
      return created;
    } catch (error) {
      logger.error(`Failed to create product: ${productData.title}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Update an existing product
   */
  async updateProduct(productId, updates) {
    try {
      const updated = await this.shopify.product.update(productId, updates);
      logger.info(`✏️ Product updated: ${productId}`);
      return updated;
    } catch (error) {
      logger.error(`Failed to update product ${productId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Update variant pricing
   */
  async updateVariantPrice(variantId, price, comparePrice = null) {
    try {
      const updates = { price: price.toFixed(2) };
      if (comparePrice) updates.compare_at_price = comparePrice.toFixed(2);
      const updated = await this.shopify.productVariant.update(variantId, updates);
      logger.debug(`💰 Variant ${variantId} price updated to $${price}`);
      return updated;
    } catch (error) {
      logger.error(`Failed to update variant price ${variantId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Update inventory level
   */
  async updateInventory(inventoryItemId, locationId, quantity) {
    try {
      await this.shopify.inventoryLevel.set({
        inventory_item_id: inventoryItemId,
        location_id: locationId,
        available: quantity
      });
      logger.debug(`📦 Inventory updated: item ${inventoryItemId} → ${quantity} units`);
    } catch (error) {
      logger.error(`Failed to update inventory`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get all products with dropship metafields
   */
  async getAllDropshipProducts() {
    try {
      const products = [];
      let params = { limit: 250, status: 'any' };

      do {
        const batch = await this.shopify.product.list(params);
        products.push(...batch);
        params = batch.nextPageParameters;
      } while (params);

      return products.filter(p =>
        p.tags.includes('dropship') ||
        p.metafields?.some(m => m.namespace === 'dropship')
      );
    } catch (error) {
      logger.error('Failed to fetch products', { error: error.message });
      throw error;
    }
  }

  /**
   * Get product metafields
   */
  async getProductMetafields(productId) {
    try {
      return await this.shopify.metafield.list({
        metafield: { owner_resource: 'product', owner_id: productId }
      });
    } catch (error) {
      logger.error(`Failed to get metafields for product ${productId}`, { error: error.message });
      return [];
    }
  }

  /**
   * Get shop locations
   */
  async getLocations() {
    try {
      return await this.shopify.location.list();
    } catch (error) {
      logger.error('Failed to get locations', { error: error.message });
      return [];
    }
  }

  _buildVariants(productData) {
    if (productData.variants?.length > 0) {
      return productData.variants.map(v => ({
        title: v.title || 'Default Title',
        price: v.price.toFixed(2),
        compare_at_price: v.comparePrice ? v.comparePrice.toFixed(2) : null,
        sku: v.sku || `DROP-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`,
        inventory_management: 'shopify',
        inventory_policy: 'deny',
        fulfillment_service: 'manual',
        weight: v.weight || 0.5,
        weight_unit: 'kg',
        option1: v.option1 || null,
        option2: v.option2 || null
      }));
    }

    return [{
      price: (productData.price || 0).toFixed(2),
      compare_at_price: productData.comparePrice ? productData.comparePrice.toFixed(2) : null,
      sku: `DROP-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`,
      inventory_management: 'shopify',
      inventory_policy: 'deny',
      fulfillment_service: 'manual',
      weight: 0.5,
      weight_unit: 'kg'
    }];
  }
}

module.exports = new ShopifyProducts();
