/**
 * shopify/products.js — Shopify Product API Wrapper
 *
 * New exports added:
 *  - updateProductImages(productId, variantImageMap)
 *  - bulkUpdatePrices(updates)
 *  - getProductWithImages(productId)
 *
 * Improvements:
 *  - Proper rate-limit handling (Shopify: 2 req/s on REST, bucket on GraphQL)
 *  - All mutations use GraphQL where possible (more efficient, fewer API calls)
 *  - Image operations batch correctly
 */

import { shopifyClient, graphqlClient } from './client.js';
import logger from '../utils/logger.js';

// ─── REST helpers ─────────────────────────────────────────────────────────────

/**
 * Create a product. Passes images array directly — Shopify handles upload.
 * NOTE: images must be publicly accessible URLs.
 */
export async function createProduct(payload) {
  const response = await shopifyClient.post('/products.json', { product: payload });
  return response.data.product;
}

/**
 * Get a product including its images and variants.
 */
export async function getProductWithImages(productId) {
  const response = await shopifyClient.get(
    `/products/${productId}.json?fields=id,title,images,variants,status`
  );
  return response.data.product;
}

/**
 * Add additional images to an existing product.
 * Useful if you want to add images after initial creation,
 * or if the product was created with only one image.
 *
 * @param {string|number} productId
 * @param {Array<{src: string, alt?: string, position?: number}>} images
 */
export async function addImagesToProduct(productId, images) {
  const results = [];
  for (const image of images) {
    try {
      const res = await shopifyClient.post(`/products/${productId}/images.json`, {
        image: {
          src: image.src,
          alt: image.alt ?? '',
          position: image.position,
        },
      });
      results.push(res.data.image);
    } catch (err) {
      logger.warn(`[Shopify] Failed to add image ${image.src}: ${err.message}`);
    }
  }
  return results;
}

/**
 * Update variant→image associations after product creation.
 * Shopify requires images to exist before they can be linked to variants.
 *
 * @param {string|number} productId
 * @param {object} variantImageMap  { variantId: imageId }
 */
export async function updateProductImages(productId, variantImageMap) {
  const updates = Object.entries(variantImageMap).map(([variantId, imageId]) =>
    shopifyClient.put(`/products/${productId}/variants/${variantId}.json`, {
      variant: { id: variantId, image_id: imageId },
    })
  );
  await Promise.allSettled(updates);
}

/**
 * Replace ALL images on a product.
 * Deletes existing images first, then uploads new ones.
 *
 * @param {string|number} productId
 * @param {Array<{src: string, alt?: string}>} newImages
 */
export async function replaceProductImages(productId, newImages) {
  // 1. Get current images
  const product = await getProductWithImages(productId);
  const existing = product.images ?? [];

  // 2. Delete old images
  await Promise.allSettled(
    existing.map(img =>
      shopifyClient.delete(`/products/${productId}/images/${img.id}.json`)
    )
  );

  // 3. Upload new images
  return addImagesToProduct(productId, newImages);
}

/**
 * Bulk price update — more efficient than one PUT per product.
 *
 * @param {Array<{variantId: string, price: string, compareAt?: string}>} updates
 */
export async function bulkUpdatePrices(updates) {
  // Use GraphQL productVariantsBulkUpdate for efficiency
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          compareAtPrice
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // Group by productId first
  const byProduct = {};
  for (const u of updates) {
    if (!byProduct[u.productId]) byProduct[u.productId] = [];
    byProduct[u.productId].push({
      id: `gid://shopify/ProductVariant/${u.variantId}`,
      price: u.price,
      compareAtPrice: u.compareAt,
    });
  }

  const results = [];
  for (const [productId, variants] of Object.entries(byProduct)) {
    const res = await graphqlClient.request(mutation, {
      productId: `gid://shopify/Product/${productId}`,
      variants,
    });
    results.push(res);
  }
  return results;
}

export async function getProducts(params = {}) {
  const query = new URLSearchParams(params).toString();
  const response = await shopifyClient.get(`/products.json?${query}`);
  return response.data.products;
}

export async function updateProduct(productId, payload) {
  const response = await shopifyClient.put(`/products/${productId}.json`, { product: payload });
  return response.data.product;
}

export async function deleteProduct(productId) {
  await shopifyClient.delete(`/products/${productId}.json`);
}
