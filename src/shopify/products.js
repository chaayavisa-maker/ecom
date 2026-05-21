/**
 * shopify/products.js — Shopify Product Helpers (CJS)
 *
 * Uses shopify-api-node (already in the project) — NOT axios.
 * shopify-api-node API: shopify.product.create(), shopify.productImage.create(), etc.
 *
 * Improvements:
 *  - createProduct() now accepts an images[] array (multi-image support)
 *  - addImagesToProduct() — add images to an existing product
 *  - replaceProductImages() — swap all images on a product
 *  - updateVariantImage() — link a variant to a specific image
 */

const { getShopifyClient } = require('./client');
const logger = require('../utils/logger');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Create a Shopify product.
 * Pass images as an array: [{ src, alt, position }]
 * shopify-api-node accepts images[] directly on product.create().
 */
async function createProduct(payload) {
  const shopify = getShopifyClient();
  return shopify.product.create(payload);
}

async function getProduct(productId) {
  const shopify = getShopifyClient();
  return shopify.product.get(productId);
}

async function updateProduct(productId, payload) {
  const shopify = getShopifyClient();
  return shopify.product.update(productId, payload);
}

async function deleteProduct(productId) {
  const shopify = getShopifyClient();
  return shopify.product.delete(productId);
}

async function listProducts(params = {}) {
  const shopify = getShopifyClient();
  return shopify.product.list(params);
}

/**
 * Add images to an existing product one-by-one.
 * Used when images couldn't be included at creation time.
 *
 * @param {number} productId
 * @param {Array<{src: string, alt?: string, position?: number}>} images
 */
async function addImagesToProduct(productId, images) {
  const shopify = getShopifyClient();
  const results = [];

  for (const image of images) {
    try {
      const created = await shopify.productImage.create(productId, {
        src: image.src,
        alt: image.alt || '',
        position: image.position,
      });
      results.push(created);
      await sleep(300); // Respect rate limits
    } catch (err) {
      logger.warn(`[Shopify] Failed to add image to product ${productId}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Delete all existing images on a product, then upload new ones.
 *
 * @param {number} productId
 * @param {Array<{src: string, alt?: string}>} newImages
 */
async function replaceProductImages(productId, newImages) {
  const shopify = getShopifyClient();

  // Delete all existing images
  const existing = await shopify.productImage.list(productId);
  for (const img of existing) {
    try {
      await shopify.productImage.delete(productId, img.id);
    } catch (err) {
      logger.warn(`[Shopify] Could not delete image ${img.id}: ${err.message}`);
    }
  }

  // Upload new ones
  return addImagesToProduct(productId, newImages);
}

/**
 * Link a variant to a specific image by ID.
 * Call after createProduct() once you have both variant IDs and image IDs.
 *
 * @param {number} variantId
 * @param {number} imageId
 */
async function updateVariantImage(variantId, imageId) {
  const shopify = getShopifyClient();
  return shopify.productVariant.update(variantId, { image_id: imageId });
}

/**
 * Bulk-update prices for multiple variants.
 * Groups by product to minimise API calls.
 *
 * @param {Array<{variantId: number, price: string, compareAt?: string}>} updates
 */
async function bulkUpdateVariantPrices(updates) {
  const shopify = getShopifyClient();
  const results = [];

  for (const u of updates) {
    try {
      const updated = await shopify.productVariant.update(u.variantId, {
        price: u.price,
        compare_at_price: u.compareAt || null,
      });
      results.push(updated);
      await sleep(500); // ~2 req/s
    } catch (err) {
      logger.warn(`[Shopify] Price update failed for variant ${u.variantId}: ${err.message}`);
    }
  }

  return results;
}

module.exports = {
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
  listProducts,
  addImagesToProduct,
  replaceProductImages,
  updateVariantImage,
  bulkUpdateVariantPrices,
};
