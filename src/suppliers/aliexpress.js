/**
 * aliexpress.js — AliExpress / CJ Dropshipping Supplier Adapter (CJS)
 *
 * Improvements:
 *  1. fetchProductImages() — fetches ALL images (not just one), normalises CDN URLs to full-res
 *  2. URL normalisation strips AliExpress size suffixes (_350x350.jpg → .jpg)
 *  3. Fallback HTML scrape when API credentials aren't set up
 *  4. Rate-limit back-off
 */

const axios = require('axios');
const logger = require('../utils/logger');

// ─── URL normalisation ────────────────────────────────────────────────────────

/**
 * Strip AliExpress CDN size suffixes so we get the full-resolution image.
 * e.g. "photo_350x350.jpg" → "photo.jpg"
 */
function normaliseImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return url
    .replace(/_\d+x\d+\.(jpg|jpeg|png|webp)/gi, '.$1')  // strip _WxH suffix
    .replace(/\?.*$/, '')                                   // strip query string
    .replace(/^http:/, 'https:');                           // force HTTPS
}

function extractProductId(productUrl) {
  if (!productUrl) return null;
  if (/^\d+$/.test(String(productUrl))) return String(productUrl);
  const match = String(productUrl).match(/\/item\/(\d+)\.html/);
  return match ? match[1] : null;
}

// ─── Image fetching ───────────────────────────────────────────────────────────

/**
 * Fetch all product images from AliExpress.
 * Tries the AliExpress API first, then falls back to HTML scraping.
 *
 * @param {string} productUrl  - AliExpress product URL or product ID
 * @param {object} options     - { limit: number }
 * @returns {Promise<Array<{url, position, isMain}>>}
 */
async function fetchProductImages(productUrl, { limit = 10 } = {}) {
  // Try API if credentials are set
  if (process.env.ALIEXPRESS_APP_KEY) {
    try {
      return await _fetchImagesFromApi(productUrl, limit);
    } catch (err) {
      logger.warn(`[AliExpress] API image fetch failed, trying scrape: ${err.message}`);
    }
  }

  // Fallback: scrape the product page HTML
  return _scrapeImagesFromPage(productUrl, limit);
}

async function _fetchImagesFromApi(productUrl, limit) {
  const productId = extractProductId(productUrl);
  if (!productId) return [];

  const response = await axios.get('https://api.aliexpress.com/v2/product/detail', {
    params: {
      productId,
      appKey: process.env.ALIEXPRESS_APP_KEY,
    },
    timeout: 10_000,
  });

  const data = response.data?.aliexpress_ds_product_get_response?.result;
  if (!data) throw new Error('Empty AliExpress API response');

  const images = [];

  // Main gallery images
  const gallery = data.imageModule?.imagePathList || [];
  gallery.forEach((url, idx) => {
    const clean = normaliseImageUrl(url);
    if (clean) images.push({ url: clean, position: idx + 1, isMain: idx === 0 });
  });

  // SKU/variant colour images
  const skuProps = data.skuModule?.productSKUPropertyList || [];
  for (const prop of skuProps) {
    for (const val of (prop.skuPropertyValues || [])) {
      if (val.skuPropertyImagePath) {
        const clean = normaliseImageUrl(val.skuPropertyImagePath);
        if (clean) images.push({ url: clean, isVariant: true, variantName: val.propertyValueDefinitionName });
      }
    }
  }

  // Deduplicate and return
  const seen = new Set();
  return images.filter(img => {
    if (seen.has(img.url)) return false;
    seen.add(img.url);
    return true;
  }).slice(0, limit);
}

async function _scrapeImagesFromPage(productUrl, limit) {
  if (!productUrl || !/aliexpress\.com/.test(productUrl)) return [];

  try {
    const response = await axios.get(productUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      timeout: 15_000,
    });

    // AliExpress embeds image list in a JS variable
    const html = response.data;
    const match = html.match(/"imagePathList"\s*:\s*(\[.*?\])/);
    if (!match) return [];

    const urls = JSON.parse(match[1]);
    return urls
      .slice(0, limit)
      .map((url, idx) => ({
        url: normaliseImageUrl(url),
        position: idx + 1,
        isMain: idx === 0,
      }))
      .filter(img => img.url);
  } catch (err) {
    logger.warn(`[AliExpress] HTML scrape failed: ${err.message}`);
    return [];
  }
}

// ─── Product search ───────────────────────────────────────────────────────────

async function searchProducts(query, options = {}) {
  const { sortBy = 'orders', minRating = 4.0, maxPrice = 20, limit = 20 } = options;

  if (!process.env.ALIEXPRESS_APP_KEY) {
    logger.warn('[AliExpress] ALIEXPRESS_APP_KEY not set — returning mock data');
    return _mockSearchResults(query, limit);
  }

  try {
    const response = await axios.get('https://api.aliexpress.com/v2/product/search', {
      params: {
        keywords: query,
        sort: sortBy === 'orders' ? 'SALE_PRICE_ASC' : 'LAST_VOLUME_DESC',
        minPrice: 1,
        maxPrice,
        pageSize: limit,
        appKey: process.env.ALIEXPRESS_APP_KEY,
      },
      timeout: 15_000,
    });

    const items = response.data?.aliexpress_ds_product_search_get_response?.result?.products?.product || [];
    return items
      .filter(p => parseFloat(p.evaluate_rate) >= minRating * 20)
      .map(p => ({
        productId: String(p.product_id),
        title: p.product_title,
        price: parseFloat(p.app_sale_price),
        imageUrl: normaliseImageUrl(p.product_main_image_url),
        productUrl: p.product_detail_url,
        rating: parseFloat(p.evaluate_rate) / 20,
        totalOrders: parseInt(p.lastest_volume || '0'),
        reviewCount: parseInt(p.evaluate_cnt || '0'),
      }));
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('[AliExpress] Rate limited — waiting 30s');
      await new Promise(r => setTimeout(r, 30_000));
    }
    logger.error(`[AliExpress] searchProducts failed: ${err.message}`);
    return [];
  }
}

function _mockSearchResults(query, limit) {
  return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
    productId: `mock-${Date.now()}-${i}`,
    title: `${query} Product ${i + 1}`,
    price: 8 + i * 2,
    imageUrl: 'https://via.placeholder.com/500',
    productUrl: `https://aliexpress.com/item/mock${i}.html`,
    rating: 4.5,
    totalOrders: 1000 + i * 200,
    reviewCount: 500 + i * 50,
  }));
}

// ─── CJ Dropshipping stub ─────────────────────────────────────────────────────

const cjDropshipping = {
  async placeOrder(orderData) {
    logger.warn('[CJ] cjDropshipping.placeOrder not implemented — returning mock');
    return { cjOrderId: `CJ-MOCK-${Date.now()}`, trackingNumber: null };
  },
};

module.exports = { fetchProductImages, searchProducts, normaliseImageUrl, cjDropshipping };
