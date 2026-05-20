const { getShopifyClient } = require('./client');
const logger = require('../utils/logger');

/**
 * Canonical store collections — every product maps to one of these.
 * Add/remove entries here to change what collections exist in your store.
 */
const STORE_COLLECTIONS = [
  { name: 'Home & Garden',       description: 'Decor, garden tools, lighting, and everything for your living space.' },
  { name: 'Electronics & Gadgets', description: 'Power banks, smart home devices, phone accessories, and tech essentials.' },
  { name: 'Fashion & Accessories', description: 'Clothing, shoes, bags, jewellery, and seasonal style picks.' },
  { name: 'Outdoor & Camping',   description: 'Camping gear, hiking equipment, and outdoor adventure essentials.' },
  { name: 'Pet Supplies',        description: 'Everything your pets need — toys, accessories, grooming, and care.' },
  { name: 'Kids & Toys',         description: 'Educational toys, games, and fun gear for children of all ages.' },
  { name: 'Beauty & Wellness',   description: 'Skincare, haircare, fitness tools, and personal wellness products.' },
  { name: 'Kitchen & Dining',    description: 'Cookware, gadgets, storage, and everything for the modern kitchen.' },
  { name: 'Sports & Fitness',    description: 'Exercise equipment, activewear, and sports accessories.' },
  { name: 'Car Accessories',     description: 'Interior, exterior, and tech accessories for your vehicle.' },
];

// In-memory cache: collection name (lowercase) → Shopify collection ID
const collectionCache = new Map();

class ShopifyCollections {
  constructor() {
    this.shopify = getShopifyClient();
  }

  /**
   * Map a raw AI category string to one of the canonical collection names.
   * Falls back to 'Home & Garden' if nothing matches.
   */
  resolveCollectionName(rawCategory) {
    if (!rawCategory) return 'Home & Garden';
    const lower = rawCategory.toLowerCase();

    const keywords = {
      'Electronics & Gadgets': ['electronic', 'gadget', 'tech', 'phone', 'power bank', 'smart', 'wireless', 'bluetooth', 'charger', 'cable', 'usb', 'device'],
      'Fashion & Accessories': ['fashion', 'cloth', 'apparel', 'shoe', 'sandal', 'flip flop', 'bag', 'jewel', 'watch', 'hat', 'cap', 'scarf', 'wear', 'dress'],
      'Outdoor & Camping':     ['outdoor', 'camp', 'hiking', 'tarp', 'tent', 'light', 'lantern', 'survival', 'trail', 'fishing'],
      'Pet Supplies':          ['pet', 'dog', 'cat', 'animal', 'paw', 'collar', 'leash', 'treat', 'bandage'],
      'Kids & Toys':           ['kid', 'child', 'baby', 'toy', 'bubble', 'play', 'infant', 'toddler', 'school'],
      'Beauty & Wellness':     ['beauty', 'skincare', 'hair', 'makeup', 'cosmetic', 'wellness', 'massage', 'health'],
      'Kitchen & Dining':      ['kitchen', 'cook', 'bak', 'utensil', 'cutlery', 'dining', 'storage', 'food'],
      'Sports & Fitness':      ['sport', 'fitness', 'gym', 'yoga', 'exercise', 'running', 'bike', 'cycle'],
      'Car Accessories':       ['car', 'vehicle', 'auto', 'driving', 'mount', 'dash', 'seat'],
      'Home & Garden':         ['home', 'garden', 'decor', 'light', 'plant', 'solar', 'string light', 'shelf', 'organizer'],
    };

    for (const [collection, terms] of Object.entries(keywords)) {
      if (terms.some(term => lower.includes(term))) {
        return collection;
      }
    }

    return 'Home & Garden';
  }

  /**
   * Load all existing custom collections from Shopify into the cache.
   */
  async _warmCache() {
    if (collectionCache.size > 0) return; // already warm
    try {
      const existing = await this.shopify.customCollection.list({ limit: 250 });
      for (const col of existing) {
        collectionCache.set(col.title.toLowerCase(), col.id);
      }
      logger.info(`📚 Collection cache warmed: ${collectionCache.size} collections`);
    } catch (err) {
      logger.warn(`Could not warm collection cache: ${err.message}`);
    }
  }

  /**
   * Get a collection ID by name, creating it if it doesn't exist yet.
   */
  async getOrCreate(collectionName) {
    await this._warmCache();
    const key = collectionName.toLowerCase();

    if (collectionCache.has(key)) {
      return collectionCache.get(key);
    }

    // Find matching definition for description
    const def = STORE_COLLECTIONS.find(c => c.name.toLowerCase() === key);
    try {
      const created = await this.shopify.customCollection.create({
        title: collectionName,
        body_html: def?.description
          ? `<p>${def.description}</p>`
          : `<p>Curated ${collectionName} products.</p>`,
        published: true,
      });
      collectionCache.set(key, created.id);
      logger.info(`📁 Created collection: "${collectionName}" (ID: ${created.id})`);
      return created.id;
    } catch (err) {
      logger.error(`Failed to create collection "${collectionName}": ${err.message}`);
      return null;
    }
  }

  /**
   * Add a product to a collection. Safe to call multiple times (Shopify deduplicates).
   */
  async addProduct(collectionId, productId) {
    if (!collectionId || !productId) return;
    try {
      await this.shopify.collect.create({
        collection_id: collectionId,
        product_id: productId,
      });
      logger.debug(`🔗 Product ${productId} → collection ${collectionId}`);
    } catch (err) {
      // Code 422 means already in collection — not an error
      if (!err.message?.includes('taken')) {
        logger.warn(`Could not add product ${productId} to collection ${collectionId}: ${err.message}`);
      }
    }
  }

  /**
   * Ensure all canonical collections exist in the store.
   * Call this once during initial setup or from the research agent.
   */
  async ensureAllCollections() {
    logger.info('📚 Ensuring all store collections exist...');
    let created = 0;
    let existing = 0;
    await this._warmCache();

    for (const col of STORE_COLLECTIONS) {
      const key = col.name.toLowerCase();
      if (collectionCache.has(key)) {
        existing++;
      } else {
        await this.getOrCreate(col.name);
        created++;
        await new Promise(r => setTimeout(r, 300)); // gentle rate limiting
      }
    }

    logger.info(`📚 Collections ready: ${existing} existing, ${created} created`);
  }
}

module.exports = new ShopifyCollections();
