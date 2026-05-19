const ai = require('../utils/aiProvider');
const shopifyProducts = require('../shopify/products');
const logger = require('../utils/logger');

class ListingAgent {
  constructor() {
    this.name = 'ListingAgent';
  }

  async processProduct(rawProduct) {
    logger.info(`📝 ${this.name} processing: "${rawProduct.title}" [${ai.providerName}]`);
    try {
      const listing = await this._generateListing(rawProduct);
      const pricing = this._calculatePrice(rawProduct);

      const shopifyPayload = {
        title: listing.title,
        description: listing.descriptionHtml,
        vendor: 'Our Store',
        category: listing.category,
        tags: listing.tags,
        images: rawProduct.images,
        price: pricing.sellingPrice,
        comparePrice: pricing.comparePrice,
        costPrice: rawProduct.price,
        supplierId: rawProduct.supplierId || rawProduct.id,
        supplierUrl: rawProduct.supplierUrl,
        supplierName: rawProduct.supplierName || 'AliExpress',
        metaTitle: listing.metaTitle,
        metaDescription: listing.metaDescription
      };

      const created = await shopifyProducts.createProduct(shopifyPayload);
      logger.info(`✅ Listed "${listing.title}" at $${pricing.sellingPrice} (cost: $${rawProduct.price})`);
      return { success: true, shopifyId: created.id, title: listing.title, price: pricing.sellingPrice, margin: pricing.marginPercent };
    } catch (error) {
      logger.error(`${this.name} failed for "${rawProduct.title}"`, { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async _generateListing(product) {
    try {
      return await ai.chatJSON({
        system: `You are an expert Shopify product listing copywriter specializing in conversion optimization and SEO.
Create compelling, authentic product listings that drive sales.`,
        prompt: `Create an optimized Shopify product listing for this dropshipped product.

Product Info:
- Original Title: ${product.title}
- Cost Price: $${product.price}
- Sales Volume: ${product.sales} sold
- Target Audience: ${product.targetAudience || 'general consumers'}
- Ad Angle: ${product.adAngle || 'quality and value'}
- Supplier: ${product.supplierName || 'overseas supplier'}

Return this JSON:
{
  "title": "...(50-70 chars, benefit-focused)",
  "descriptionHtml": "<h2>...</h2><ul>...</ul>...(hook + benefits + features + CTA)",
  "tags": ["tag1", "tag2", ...8-12 tags],
  "category": "...",
  "metaTitle": "...(max 60 chars)",
  "metaDescription": "...(max 155 chars)",
  "keySellingPoints": ["point1", "point2", "point3"]
}`,
        maxTokens: 1500
      });
    } catch (error) {
      logger.warn('Listing generation failed, using fallback');
      return this._generateFallbackListing(product);
    }
  }

  _calculatePrice(product) {
    const costPrice = parseFloat(product.price);
    const markupPercent = product.suggestedMarkup || parseInt(process.env.DEFAULT_MARKUP_PERCENT || 200);
    const shippingBuffer = parseFloat(process.env.SHIPPING_BUFFER || 5);
    const minMargin = parseFloat(process.env.MIN_PROFIT_MARGIN || 30);

    let sellingPrice = (costPrice + shippingBuffer) * (1 + markupPercent / 100);
    sellingPrice = Math.ceil(sellingPrice) - 0.01;

    const actualMargin = ((sellingPrice - costPrice - shippingBuffer) / sellingPrice) * 100;
    if (actualMargin < minMargin) {
      sellingPrice = (costPrice + shippingBuffer) / (1 - minMargin / 100);
      sellingPrice = Math.ceil(sellingPrice) - 0.01;
    }

    const comparePrice = parseFloat((sellingPrice * 1.4).toFixed(2));
    const marginPercent = ((sellingPrice - costPrice - shippingBuffer) / sellingPrice * 100).toFixed(1);

    return { sellingPrice: parseFloat(sellingPrice.toFixed(2)), comparePrice, costPrice, marginPercent: parseFloat(marginPercent) };
  }

  _generateFallbackListing(product) {
    const cleanTitle = product.title.replace(/\b\w/g, c => c.toUpperCase()).substring(0, 70);
    return {
      title: cleanTitle,
      descriptionHtml: `<h2>Premium Quality ${cleanTitle}</h2><p>High-quality product trusted by thousands of happy customers.</p><ul><li>✅ Premium quality materials</li><li>✅ Fast international shipping</li><li>✅ 30-day money-back guarantee</li><li>✅ 24/7 customer support</li></ul>`,
      tags: ['dropship', 'trending', 'sale'],
      category: 'General',
      metaTitle: cleanTitle.substring(0, 60),
      metaDescription: `Buy ${cleanTitle} at the best price. Fast shipping, quality guaranteed.`.substring(0, 155),
      keySellingPoints: ['Quality guaranteed', 'Fast shipping', 'Best price']
    };
  }

  async bulkProcess(products) {
    const results = [];
    for (const product of products) {
      const result = await this.processProduct(product);
      results.push(result);
      await new Promise(r => setTimeout(r, 2000));
    }
    const successes = results.filter(r => r.success).length;
    logger.info(`📦 Bulk listing complete: ${successes}/${products.length} successful`);
    return results;
  }
}

module.exports = new ListingAgent();
