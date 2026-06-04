/**
 * aliexpress.js — AliExpress / CJ Supplier Adapter (CJS)
 *
 * searchProducts() works in 3 modes:
 *   1. AliExpress Affiliate API  — when ALIEXPRESS_APP_KEY is set
 *   2. Development mock data     — when ALIEXPRESS_APP_KEY is NOT set (clearly logged)
 *   3. Fallback                  — on API error (rate limits etc.)
 *
 * fetchProductImages() fetches ALL product images and normalises CDN URLs to full-res.
 */

'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

// ─── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Strip AliExpress CDN size suffixes to get full-resolution images.
 * e.g. "photo_350x350.jpg" → "photo.jpg"
 */
function normaliseImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return url
    .replace(/_\d+x\d+\.(jpg|jpeg|png|webp)/gi, '.$1')
    .replace(/\?.*$/, '')
    .replace(/^http:/, 'https:');
}

function extractProductId(productUrl) {
  if (!productUrl) return null;
  if (/^\d+$/.test(String(productUrl))) return String(productUrl);
  const match = String(productUrl).match(/\/item\/(\d+)\.html/);
  return match ? match[1] : null;
}

// ─── Mock data (development / no API key) ────────────────────────────────────

/**
 * Returns realistic mock products so the full pipeline can be tested
 * without an AliExpress API key.
 */
function _mockSearchResults(query, limit = 5) {
  logger.warn(`[AliExpress] ⚠️  ALIEXPRESS_APP_KEY not set — using mock data for "${query}"`);
  logger.warn('[AliExpress] Set ALIEXPRESS_APP_KEY in .env to search real products');

  const mockProducts = [
    {
      productId: `mock-${Date.now()}-1`,
      title: `Premium ${query} - Bestseller Edition`,
      price: 8.99,
      cost: 8.99,
      imageUrl: 'https://picsum.photos/seed/product1/800/800',
      productUrl: `https://www.aliexpress.com/item/1234567890.html`,
      supplierUrl: `https://www.aliexpress.com/item/1234567890.html`,
      rating: 4.7,
      totalOrders: 15420,
      reviewCount: 2891,
    },
    {
      productId: `mock-${Date.now()}-2`,
      title: `${query} Pro Model - Free Shipping`,
      price: 12.49,
      cost: 12.49,
      imageUrl: 'https://picsum.photos/seed/product2/800/800',
      productUrl: `https://www.aliexpress.com/item/9876543210.html`,
      supplierUrl: `https://www.aliexpress.com/item/9876543210.html`,
      rating: 4.5,
      totalOrders: 8760,
      reviewCount: 1204,
    },
    {
      productId: `mock-${Date.now()}-3`,
      title: `${query} Deluxe Set - Top Rated`,
      price: 15.99,
      cost: 15.99,
      imageUrl: 'https://picsum.photos/seed/product3/800/800',
      productUrl: `https://www.aliexpress.com/item/1122334455.html`,
      supplierUrl: `https://www.aliexpress.com/item/1122334455.html`,
      rating: 4.8,
      totalOrders: 22100,
      reviewCount: 4312,
    },
  ];

  return mockProducts.slice(0, Math.min(limit, mockProducts.length));
}

// ─── Image fetching ───────────────────────────────────────────────────────────

/**
 * Fetch all available images for a product.
 * Uses API if ALIEXPRESS_APP_KEY set, otherwise tries HTML scraping, then returns imageUrl fallback.
 */
async function fetchProductImages(productUrl, { limit = 10 } = {}) {
  if (!productUrl) return [];

  // Mock URL — return placeholder images
  if (productUrl.includes('mock') || productUrl.includes('picsum')) {
    return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
      url: `https://picsum.photos/seed/product${i + 1}/800/800`,
      position: i + 1,
      isMain: i === 0,
    }));
  }

  if (process.env.ALIEXPRESS_APP_KEY) {
    try {
      return await _fetchImagesFromApi(productUrl, limit);
    } catch (err) {
      logger.warn(`[AliExpress] API image fetch failed: ${err.message} — trying scrape`);
    }
  }

  return _scrapeImagesFromPage(productUrl, limit);
}

async function _fetchImagesFromApi(productUrl, limit) {
  const productId = extractProductId(productUrl);
  if (!productId) return [];

  const response = await axios.get('https://api.aliexpress.com/v2/product/detail', {
    params: { productId, appKey: process.env.ALIEXPRESS_APP_KEY },
    timeout: 10_000,
  });

  const data = response.data?.aliexpress_ds_product_get_response?.result;
  if (!data) throw new Error('Empty AliExpress API response');

  const images = [];
  const gallery = data.imageModule?.imagePathList || [];
  gallery.forEach((url, idx) => {
    const clean = normaliseImageUrl(url);
    if (clean) images.push({ url: clean, position: idx + 1, isMain: idx === 0 });
  });

  // SKU/variant colour images
  for (const prop of (data.skuModule?.productSKUPropertyList || [])) {
    for (const val of (prop.skuPropertyValues || [])) {
      if (val.skuPropertyImagePath) {
        const clean = normaliseImageUrl(val.skuPropertyImagePath);
        if (clean) images.push({ url: clean, isVariant: true, variantName: val.propertyValueDefinitionName });
      }
    }
  }

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

    const match = response.data.match(/"imagePathList"\s*:\s*(\[.*?\])/);
    if (!match) return [];

    const urls = JSON.parse(match[1]);
    return urls
      .slice(0, limit)
      .map((url, idx) => ({ url: normaliseImageUrl(url), position: idx + 1, isMain: idx === 0 }))
      .filter(img => img.url);
  } catch (err) {
    logger.warn(`[AliExpress] HTML scrape failed: ${err.message}`);
    return [];
  }
}

// ─── Product search ───────────────────────────────────────────────────────────

async function searchProducts(query, options = {}) {
  const { minRating = 4.0, maxPrice = 20, limit = 20 } = options;

  // No API key → use mock data so the pipeline can be tested end-to-end
  if (!process.env.ALIEXPRESS_APP_KEY) {
    return _mockSearchResults(query, limit);
  }

  try {
    const response = await axios.get('https://api.aliexpress.com/v2/product/search', {
      params: {
        keywords: query,
        sort: 'LAST_VOLUME_DESC',
        minPrice: 1,
        maxPrice,
        pageSize: limit,
        appKey: process.env.ALIEXPRESS_APP_KEY,
      },
      timeout: 15_000,
    });

    const items = response.data
      ?.aliexpress_ds_product_search_get_response
      ?.result?.products?.product || [];

    const results = items
      .filter(p => parseFloat(p.evaluate_rate || '0') >= minRating * 20)
      .map(p => ({
        productId:   String(p.product_id),
        title:       p.product_title,
        price:       parseFloat(p.app_sale_price),
        cost:        parseFloat(p.app_sale_price),
        imageUrl:    normaliseImageUrl(p.product_main_image_url),
        productUrl:  p.product_detail_url,
        supplierUrl: p.product_detail_url,
        rating:      parseFloat(p.evaluate_rate || '0') / 20,
        totalOrders: parseInt(p.lastest_volume || '0'),
        reviewCount: parseInt(p.evaluate_cnt || '0'),
      }));

    logger.info(`[AliExpress] "${query}" → ${results.length} products`);
    return results;

  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('[AliExpress] Rate limited — waiting 30s');
      await new Promise(r => setTimeout(r, 30_000));
    }
    logger.error(`[AliExpress] searchProducts failed: ${err.message}`);
    return [];
  }
}

// ─── CJ Dropshipping ──────────────────────────────────────────────────────────

const cjDropshipping = {
  async placeOrder(orderData) {
    logger.warn('[CJ] placeOrder not fully implemented — returning placeholder');
    return { cjOrderId: `CJ-${Date.now()}`, trackingNumber: null };
  },
};

module.exports = { fetchProductImages, searchProducts, normaliseImageUrl, cjDropshipping };
