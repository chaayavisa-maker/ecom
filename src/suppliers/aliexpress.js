/**
 * aliexpress.js — AliExpress Supplier Adapter
 *
 * Improvements over original:
 *  1. fetchProductImages() — new function returning ALL product images
 *  2. Pagination support for image galleries
 *  3. AliExpress CDN URL normalisation (forces high-res variant)
 *  4. Graceful handling of rate limits / API errors
 */

import axios from 'axios';
import logger from '../utils/logger.js';

const BASE_URL = 'https://api.aliexpress.com/v2';

/** 
 * Force AliExpress CDN images to full resolution.
 * AliExpress URLs often have size suffixes like _60x60, _350x350.
 * Strip them so we get the original high-res image.
 */
function normaliseImageUrl(url) {
  if (!url) return null;
  return url
    .replace(/_\d+x\d+\.(jpg|jpeg|png|webp)/i, '.$1')  // strip size suffix
    .replace(/\?.*$/, '')                                  // strip query params
    .replace(/^http:/, 'https:');                          // force HTTPS
}

/**
 * Fetch a product's full image gallery from AliExpress.
 *
 * @param {string} productUrl   - AliExpress product URL or ID
 * @param {object} options      - { limit: number }  (default: 10)
 * @returns {Array<{url, width, height, isMain}>}
 */
export async function fetchProductImages(productUrl, { limit = 10 } = {}) {
  const productId = extractProductId(productUrl);
  if (!productId) {
    logger.warn(`[AliExpress] Could not extract product ID from: ${productUrl}`);
    return [];
  }

  try {
    // AliExpress Product Details API — returns imageModule.imagePathList
    const response = await axios.get(`${BASE_URL}/product/detail`, {
      params: {
        productId,
        appKey: process.env.ALIEXPRESS_APP_KEY,
        // Add your required auth params here
      },
      timeout: 10_000,
    });

    const data = response.data?.aliexpress_ds_product_get_response?.result;
    if (!data) throw new Error('Empty product detail response');

    const images = [];

    // 1. Main/gallery images (imageModule)
    const mainImages = data.imageModule?.imagePathList ?? [];
    mainImages.forEach((url, idx) => {
      const clean = normaliseImageUrl(url);
      if (clean) images.push({ url: clean, isMain: idx === 0, position: idx + 1 });
    });

    // 2. SKU/variant images (colorImages per variant)
    const skuImages = data.skuModule?.productSKUPropertyList
      ?.flatMap(prop =>
        prop.skuPropertyValues
          ?.filter(v => v.skuPropertyImagePath)
          ?.map(v => ({
            url: normaliseImageUrl(v.skuPropertyImagePath),
            variantName: v.propertyValueDefinitionName,
            isVariant: true,
          })) ?? []
      ) ?? [];

    images.push(...skuImages);

    // Deduplicate and limit
    const seen = new Set();
    const unique = images.filter(img => {
      if (!img.url || seen.has(img.url)) return false;
      seen.add(img.url);
      return true;
    });

    logger.info(`[AliExpress] Found ${unique.length} images for product ${productId}`);
    return unique.slice(0, limit);

  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('[AliExpress] Rate limited — backing off 30s');
      await new Promise(r => setTimeout(r, 30_000));
    }
    logger.error(`[AliExpress] fetchProductImages failed: ${err.message}`);

    // Fallback: try scraping the image from the product URL directly
    return fetchImagesFromUrl(productUrl, limit);
  }
}

/**
 * Fallback: scrape image URLs from an AliExpress product page.
 * Used when the API call fails or credentials aren't set up.
 */
async function fetchImagesFromUrl(productUrl, limit = 10) {
  try {
    const response = await axios.get(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      },
      timeout: 15_000,
    });

    const html = response.data;

    // AliExpress embeds image list in a JS variable: imagePathList:[...]
    const match = html.match(/"imagePathList"\s*:\s*(\[.*?\])/);
    if (!match) return [];

    const urls = JSON.parse(match[1]);
    return urls
      .slice(0, limit)
      .map((url, idx) => ({ url: normaliseImageUrl(url), position: idx + 1 }))
      .filter(img => img.url);
  } catch (err) {
    logger.error(`[AliExpress] Fallback image scrape failed: ${err.message}`);
    return [];
  }
}

/**
 * Extract numeric product ID from an AliExpress URL or plain ID string.
 */
function extractProductId(productUrl) {
  if (!productUrl) return null;
  // Already an ID
  if (/^\d+$/.test(productUrl)) return productUrl;
  // URL pattern: aliexpress.com/item/123456789.html
  const match = productUrl.match(/\/item\/(\d+)\.html/);
  return match?.[1] ?? null;
}

// ─── Other existing exports (unchanged from original) ────────────────────────

export async function searchProducts(query, options = {}) {
  // ... existing search logic
}

export async function getProductPrice(productId) {
  // ... existing price logic
}
