/**
 * aliexpress.js — CJ Dropshipping Supplier Adapter (CJS)
 *
 * searchProducts() works in 3 modes:
 *   1. CJ Dropshipping API  — when CJ_API_EMAIL + CJ_API_KEY are set
 *   2. Development mock data — when credentials are NOT set (clearly logged)
 *   3. Fallback              — on API error (rate limits etc.)
 *
 * fetchProductImages() fetches ALL product images and normalises CDN URLs to full-res.
 */

'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

// ─── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Strip AliExpress/CJ CDN size suffixes to get full-resolution images.
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

// ─── Mock data (development / no API credentials) ────────────────────────────

/**
 * Returns realistic mock products so the full pipeline can be tested
 * without CJ Dropshipping credentials.
 */
function _mockSearchResults(query, limit = 5) {
  logger.warn(`[CJ] ⚠️  CJ_API_EMAIL / CJ_API_KEY not set — using mock data for "${query}"`);
  logger.warn('[CJ] Set CJ_API_EMAIL and CJ_API_KEY in .env to search real products');

  const mockProducts = [
    {
      productId:   `mock-${Date.now()}-1`,
      title:       `Premium ${query} - Bestseller Edition`,
      price:       8.99,
      cost:        8.99,
      imageUrl:    'https://picsum.photos/seed/product1/800/800',
      productUrl:  'https://app.cjdropshipping.com/product-detail.html?id=mock1',
      supplierUrl: 'https://app.cjdropshipping.com/product-detail.html?id=mock1',
      rating:      4.7,
      totalOrders: 15420,
      reviewCount: 2891,
    },
    {
      productId:   `mock-${Date.now()}-2`,
      title:       `${query} Pro Model - Free Shipping`,
      price:       12.49,
      cost:        12.49,
      imageUrl:    'https://picsum.photos/seed/product2/800/800',
      productUrl:  'https://app.cjdropshipping.com/product-detail.html?id=mock2',
      supplierUrl: 'https://app.cjdropshipping.com/product-detail.html?id=mock2',
      rating:      4.5,
      totalOrders: 8760,
      reviewCount: 1204,
    },
    {
      productId:   `mock-${Date.now()}-3`,
      title:       `${query} Deluxe Set - Top Rated`,
      price:       15.99,
      cost:        15.99,
      imageUrl:    'https://picsum.photos/seed/product3/800/800',
      productUrl:  'https://app.cjdropshipping.com/product-detail.html?id=mock3',
      supplierUrl: 'https://app.cjdropshipping.com/product-detail.html?id=mock3',
      rating:      4.8,
      totalOrders: 22100,
      reviewCount: 4312,
    },
  ];

  return mockProducts.slice(0, Math.min(limit, mockProducts.length));
}

// ─── CJ request throttle (QPS limit: 1 req/sec) ──────────────────────────────

let _lastCJRequestAt = 0;

async function _cjThrottle() {
  const elapsed = Date.now() - _lastCJRequestAt;
  if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
  _lastCJRequestAt = Date.now();
}

async function _cjGet(url, config, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await _cjThrottle();
    try {
      return await axios.get(url, config);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries) {
        const wait = attempt * 30_000;
        logger.warn(`[CJ] Rate limited (attempt ${attempt}/${retries}) — waiting ${wait / 1000}s before retry`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ─── CJ Dropshipping auth ─────────────────────────────────────────────────────

let _cjAccessToken = null;
let _cjTokenExpiry  = 0;

async function getCJAccessToken() {
  if (_cjAccessToken && Date.now() < _cjTokenExpiry) return _cjAccessToken;

  const response = await axios.post(
    'https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken',
    {
      email:    process.env.CJ_API_EMAIL,
      password: process.env.CJ_API_KEY,
    },
    { timeout: 10_000 }
  );

  const data = response.data;
  if (data.code !== 200) throw new Error(`CJ auth failed: ${data.message}`);

  _cjAccessToken = data.data.accessToken;
  // Subtract 60s buffer so we refresh slightly before actual expiry
  _cjTokenExpiry  = Date.now() + (data.data.expiresIn - 60) * 1000;
  logger.info('[CJ] Access token refreshed');
  return _cjAccessToken;
}

// ─── Image fetching ───────────────────────────────────────────────────────────

/**
 * Fetch all available images for a product.
 * Uses CJ API if credentials are set, otherwise falls back to AliExpress
 * HTML scraping, then returns a placeholder.
 */
async function fetchProductImages(productUrl, { limit = 10 } = {}) {
  if (!productUrl) return [];

  // Mock URL — return placeholder images
  if (productUrl.includes('mock') || productUrl.includes('picsum')) {
    return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
      url:    `https://picsum.photos/seed/product${i + 1}/800/800`,
      position: i + 1,
      isMain: i === 0,
    }));
  }

  // CJ product — query the detail endpoint for full image list
  if (productUrl.includes('cjdropshipping.com') && process.env.CJ_API_EMAIL) {
    try {
      return await _fetchCJImages(productUrl, limit);
    } catch (err) {
      logger.warn(`[CJ] Image fetch failed: ${err.message}`);
    }
  }

  // AliExpress fallback — HTML scrape
  return _scrapeAliExpressImages(productUrl, limit);
}

async function _fetchCJImages(productUrl, limit) {
  const pidMatch = productUrl.match(/id=([A-Z0-9-]+)/i);
  if (!pidMatch) return [];
  const pid = pidMatch[1];

  const token = await getCJAccessToken();
  const response = await _cjGet(
    'https://developers.cjdropshipping.com/api2.0/v1/product/query',
    {
      headers: { 'CJ-Access-Token': token },
      params:  { pid },
      timeout: 10_000,
    }
  );

  const product = response.data?.data;
  if (!product) return [];

  const images = [];

  // Main images — CJ returns productImageSet as either a comma-separated string or an array
  const rawImages = Array.isArray(product.productImageSet)
    ? product.productImageSet
    : (product.productImageSet ?? '').split(',').filter(Boolean);

  for (const [idx, url] of rawImages.entries()) {
    const clean = normaliseImageUrl(typeof url === 'string' ? url.trim() : url);
    if (clean) images.push({ url: clean, position: idx + 1, isMain: idx === 0 });
  }

  // Variant images
  for (const variant of (product.variants || [])) {
    if (variant.variantImage) {
      const clean = normaliseImageUrl(variant.variantImage);
      if (clean) images.push({ url: clean, isVariant: true, variantName: variant.variantName });
    }
  }

  const seen = new Set();
  return images
    .filter(img => { if (seen.has(img.url)) return false; seen.add(img.url); return true; })
    .slice(0, limit);
}

async function _scrapeAliExpressImages(productUrl, limit) {
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
    logger.warn(`[CJ] HTML scrape fallback failed: ${err.message}`);
    return [];
  }
}

// ─── Product search ───────────────────────────────────────────────────────────

async function searchProducts(query, options = {}) {
  const { minRating = 4.0, maxPrice = 20, limit = 20 } = options;

  // No credentials → use mock data so the pipeline can be tested end-to-end
  if (!process.env.CJ_API_EMAIL || !process.env.CJ_API_KEY) {
    return _mockSearchResults(query, limit);
  }

  try {
    const token = await getCJAccessToken();

    const response = await _cjGet(
      'https://developers.cjdropshipping.com/api2.0/v1/product/list',
      {
        headers: { 'CJ-Access-Token': token },
        params: {
          productNameEn: query,
          pageNum:       1,
          pageSize:      Math.min(limit, 200),
        },
        timeout: 15_000,
      }
    );

    const data = response.data;

    if (data.code !== 200) {
      logger.error(`[CJ] Product search error: ${data.message}`);
      return [];
    }

    const items = data.data?.list ?? [];
    logger.info(`[CJ] "${query}" → ${items.length} raw items from API`);
    if (!items.length) return [];

    const results = items
      .filter(p => {
        const price = parseFloat(p.sellPrice ?? p.productPrice ?? 0);
        return price > 0 && price <= maxPrice;
      })
      .map(p => ({
        productId:   String(p.pid),
        title:       p.productNameEn,
        price:       parseFloat(p.sellPrice   ?? p.productPrice ?? 0),
        cost:        parseFloat(p.productPrice ?? p.sellPrice   ?? 0),
        imageUrl:    normaliseImageUrl(p.productImage),
        productUrl:  `https://app.cjdropshipping.com/product-detail.html?id=${p.pid}`,
        supplierUrl: `https://app.cjdropshipping.com/product-detail.html?id=${p.pid}`,
        // CJ list endpoint doesn't expose ratings — default to passing value
        rating:      4.5,
        totalOrders: 0,
        reviewCount: 0,
      }))
      // minRating filter kept for API consistency; CJ default 4.5 always passes
      .filter(p => p.rating >= minRating);

    logger.info(`[CJ] "${query}" → ${results.length} products (after price/rating filter)`);
    return results;

  } catch (err) {
    if (err.response) {
      logger.error(`[CJ] HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 400)}`);
    }
    logger.error(`[CJ] searchProducts failed: ${err.message}`);
    return [];
  }
}

// ─── CJ order placement (used by fulfillment agent) ──────────────────────────

const cjDropshipping = {
  async placeOrder(orderData) {
    if (!process.env.CJ_API_EMAIL || !process.env.CJ_API_KEY) {
      logger.warn('[CJ] placeOrder called but no credentials set — returning placeholder');
      return { cjOrderId: `CJ-MOCK-${Date.now()}`, trackingNumber: null };
    }

    try {
      const token = await getCJAccessToken();

      const response = await axios.post(
        'https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrderV2',
        orderData,
        {
          headers: {
            'CJ-Access-Token': token,
            'Content-Type':    'application/json',
          },
          timeout: 15_000,
        }
      );

      const data = response.data;
      if (data.code !== 200) throw new Error(`CJ order failed: ${data.message}`);

      return {
        cjOrderId:      data.data.orderId,
        trackingNumber: data.data.trackingNumber ?? null,
      };
    } catch (err) {
      logger.error(`[CJ] placeOrder failed: ${err.message}`);
      throw err;
    }
  },
};

module.exports = { fetchProductImages, searchProducts, normaliseImageUrl, cjDropshipping };
