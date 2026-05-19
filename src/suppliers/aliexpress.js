const axios = require('axios');
const logger = require('../utils/logger');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

class AliExpressSupplier {
  constructor() {
    this.baseUrl = 'https://api-sg.aliexpress.com/sync';
    this.appKey = process.env.ALIEXPRESS_APP_KEY;
    this.appSecret = process.env.ALIEXPRESS_APP_SECRET;
    this.affiliateId = process.env.ALIEXPRESS_AFFILIATE_ID;
  }

  /**
   * Search AliExpress products via Affiliate API (free)
   */
  async searchProducts(keyword, { minSales = 100, maxPrice = 50, category = '' } = {}) {
    const cacheKey = `ali_search_${keyword}_${maxPrice}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      // AliExpress Affiliate API - Free tier
      const params = {
        method: 'aliexpress.affiliate.product.query',
        app_key: this.appKey,
        sign_method: 'md5',
        timestamp: Date.now(),
        v: '2.0',
        keywords: keyword,
        target_currency: 'USD',
        target_language: 'EN',
        page_no: 1,
        page_size: 20,
        sort: 'SALE_PRICE_ASC',
        min_sale_price: 1,
        max_sale_price: maxPrice * 100 // in cents
      };

      if (this.affiliateId) params.tracking_id = this.affiliateId;

      const response = await axios.get(this.baseUrl, {
        params: this._signRequest(params),
        timeout: 15000
      });

      const data = response.data?.aliexpress_affiliate_product_query_response;
      if (!data?.resp_result?.result?.products?.product) {
        logger.warn(`No AliExpress results for keyword: ${keyword}`);
        return [];
      }

      const products = data.resp_result.result.products.product
        .filter(p => parseInt(p.lastest_volume || 0) >= minSales)
        .map(p => this._normalizeProduct(p));

      cache.set(cacheKey, products);
      logger.info(`🔍 AliExpress: Found ${products.length} products for "${keyword}"`);
      return products;
    } catch (error) {
      logger.error(`AliExpress search failed for "${keyword}"`, { error: error.message });
      return [];
    }
  }

  /**
   * Get product details by ID
   */
  async getProductDetails(productId) {
    const cacheKey = `ali_product_${productId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const params = {
        method: 'aliexpress.affiliate.productdetail.get',
        app_key: this.appKey,
        sign_method: 'md5',
        timestamp: Date.now(),
        v: '2.0',
        product_ids: productId,
        target_currency: 'USD',
        target_language: 'EN',
        fields: 'product_id,product_title,sale_price,original_price,product_detail_url,product_main_image_url,product_small_image_urls,lastest_volume,commission_rate,evaluate_rate,shop_id,ship_to_days'
      };

      const response = await axios.get(this.baseUrl, {
        params: this._signRequest(params),
        timeout: 15000
      });

      const data = response.data?.aliexpress_affiliate_productdetail_get_response;
      const product = data?.resp_result?.result?.products?.product?.[0];

      if (!product) return null;

      const normalized = this._normalizeProduct(product);
      cache.set(cacheKey, normalized, 7200); // 2 hour cache
      return normalized;
    } catch (error) {
      logger.error(`Failed to get AliExpress product ${productId}`, { error: error.message });
      return null;
    }
  }

  /**
   * Get shipping time estimate
   */
  async getShippingInfo(productId, targetCountry = 'US') {
    try {
      const params = {
        method: 'aliexpress.solution.product.freight.query',
        app_key: this.appKey,
        sign_method: 'md5',
        timestamp: Date.now(),
        v: '2.0',
        product_id: productId,
        country_code: targetCountry,
        product_count: 1
      };

      const response = await axios.get(this.baseUrl, {
        params: this._signRequest(params),
        timeout: 10000
      });

      const freights = response.data?.aliexpress_solution_product_freight_query_response?.result?.aeop_freight_calculate_result_dto_list?.aeop_freight_calculate_result_dto || [];

      return freights.map(f => ({
        method: f.service_name,
        days: f.estimated_delivery_time,
        price: parseFloat(f.freight?.amount || 0),
        tracking: f.tracking_available === 'true'
      }));
    } catch (error) {
      logger.warn(`Could not get shipping info for product ${productId}`);
      return [{ method: 'AliExpress Standard', days: '15-30', price: 0, tracking: true }];
    }
  }

  _normalizeProduct(raw) {
    const price = parseFloat(raw.sale_price || raw.target_sale_price || '0');
    const originalPrice = parseFloat(raw.original_price || raw.target_original_price || price);

    return {
      id: String(raw.product_id),
      title: raw.product_title || raw.product_name || 'Unknown Product',
      price,
      originalPrice,
      supplierUrl: raw.product_detail_url || raw.promotion_link || '',
      images: this._extractImages(raw),
      sales: parseInt(raw.lastest_volume || 0),
      rating: parseFloat(raw.evaluate_rate || '0') / 20, // normalize to 0-5
      commissionRate: parseFloat(raw.commission_rate || '0'),
      shippingDays: raw.ship_to_days || '15-30',
      shopId: raw.shop_id,
      supplierName: 'AliExpress',
      supplierId: String(raw.product_id)
    };
  }

  _extractImages(raw) {
    const images = [];
    if (raw.product_main_image_url) images.push(raw.product_main_image_url);
    if (raw.product_small_image_urls?.string) {
      const urls = Array.isArray(raw.product_small_image_urls.string)
        ? raw.product_small_image_urls.string
        : [raw.product_small_image_urls.string];
      images.push(...urls.slice(0, 5));
    }
    return [...new Set(images)]; // deduplicate
  }

  _signRequest(params) {
    // MD5 signing for AliExpress API
    const crypto = require('crypto');
    const sortedParams = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
    const stringToSign = `${this.appSecret}${sortedParams}${this.appSecret}`;
    params.sign = crypto.createHash('md5').update(stringToSign).digest('hex').toUpperCase();
    return params;
  }
}

// ============================================================
// CJ DROPSHIPPING (Free alternative / backup supplier)
// ============================================================
class CJDropshipping {
  constructor() {
    this.baseUrl = 'https://developers.cjdropshipping.com/api2.0/v1';
    this.apiKey = process.env.CJ_API_KEY;
    this.token = null;
    this.tokenExpiry = null;
  }

  async getToken() {
    if (this.token && this.tokenExpiry > Date.now()) return this.token;

    try {
      const response = await axios.post(`${this.baseUrl}/authentication/getAccessToken`, {
        email: process.env.CJ_EMAIL,
        password: process.env.CJ_API_KEY
      });

      this.token = response.data?.data?.accessToken;
      this.tokenExpiry = Date.now() + (response.data?.data?.expiresIn || 3600) * 1000;
      return this.token;
    } catch (error) {
      logger.error('CJ Dropshipping auth failed', { error: error.message });
      throw error;
    }
  }

  async searchProducts(keyword, { maxPrice = 50 } = {}) {
    const cacheKey = `cj_search_${keyword}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/product/list`, {
        headers: { 'CJ-Access-Token': token },
        params: {
          productNameEn: keyword,
          pageSize: 20,
          pageNum: 1,
          priceMin: 0.5,
          priceMax: maxPrice
        },
        timeout: 15000
      });

      const products = (response.data?.data?.list || []).map(p => ({
        id: p.pid,
        title: p.productNameEn,
        price: parseFloat(p.sellPrice || p.productWeight || 0),
        images: [p.productImage, ...(p.productImageSet || [])].filter(Boolean),
        sales: 0,
        rating: 4.0,
        supplierUrl: `https://cjdropshipping.com/product/${p.pid}.html`,
        shippingDays: '7-15',
        supplierName: 'CJ Dropshipping',
        supplierId: p.pid,
        variants: (p.variants || []).map(v => ({
          title: v.variantNameEn,
          sku: v.vid,
          price: parseFloat(v.variantSellPrice || p.sellPrice)
        }))
      }));

      cache.set(cacheKey, products);
      logger.info(`🔍 CJ: Found ${products.length} products for "${keyword}"`);
      return products;
    } catch (error) {
      logger.error(`CJ search failed for "${keyword}"`, { error: error.message });
      return [];
    }
  }

  /**
   * Place order with CJ for auto-fulfillment
   */
  async placeOrder(orderData) {
    try {
      const token = await this.getToken();

      const response = await axios.post(`${this.baseUrl}/shopping/order/createOrder`, {
        orderNumber: orderData.shopifyOrderId,
        shippingZip: orderData.shipping.zip,
        shippingCountryCode: orderData.shipping.countryCode,
        shippingCountry: orderData.shipping.country,
        shippingProvince: orderData.shipping.province,
        shippingCity: orderData.shipping.city,
        shippingAddress: orderData.shipping.address1,
        shippingAddress2: orderData.shipping.address2,
        shippingCustomerName: orderData.shipping.name,
        shippingPhone: orderData.shipping.phone,
        products: orderData.items.map(item => ({
          vid: item.variantSku,
          quantity: item.quantity
        }))
      }, {
        headers: { 'CJ-Access-Token': token },
        timeout: 20000
      });

      if (response.data?.result) {
        logger.info(`✅ CJ order placed: ${response.data?.data?.orderId}`);
        return {
          success: true,
          cjOrderId: response.data?.data?.orderId,
          trackingNumber: response.data?.data?.trackNo
        };
      }

      throw new Error(response.data?.message || 'CJ order failed');
    } catch (error) {
      logger.error('CJ order placement failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Get tracking info for a CJ order
   */
  async getTracking(cjOrderId) {
    try {
      const token = await this.getToken();
      const response = await axios.get(`${this.baseUrl}/shopping/order/getOrderDetail`, {
        headers: { 'CJ-Access-Token': token },
        params: { orderId: cjOrderId },
        timeout: 10000
      });

      const data = response.data?.data;
      return {
        trackingNumber: data?.trackNo,
        trackingUrl: data?.trackUrl,
        carrier: data?.shippingName,
        status: data?.orderStatus
      };
    } catch (error) {
      logger.error(`Failed to get CJ tracking for ${cjOrderId}`, { error: error.message });
      return null;
    }
  }
}

// Export both suppliers
module.exports = {
  aliexpress: new AliExpressSupplier(),
  cjDropshipping: new CJDropshipping()
};
