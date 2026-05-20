const ai = require('../utils/aiProvider');
const shopifyProducts = require('../shopify/products');
const shopifyCollections = require('../shopify/collections');
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

      // Resolve which collection this product belongs to
      const collectionName = shopifyCollections.resolveCollectionName(
        listing.collection || rawProduct.category || listing.category
      );

      const shopifyPayload = {
        title: listing.title,
        description: listing.descriptionHtml,
        vendor: 'Our Store',
        category: collectionName,
        tags: [...(listing.tags || []), 'dropship', collectionName.toLowerCase().replace(/[^a-z0-9]/g, '-')],
        images: rawProduct.images,
        price: pricing.sellingPrice,
        comparePrice: pricing.comparePrice,
        costPrice: rawProduct.price,
        supplierId: rawProduct.supplierId || rawProduct.id,
        supplierUrl: rawProduct.supplierUrl,
        supplierName: rawProduct.supplierName || 'AliExpress',
        metaTitle: listing.metaTitle,
        metaDescription: listing.metaDescription,
      };

      const created = await shopifyProducts.createProduct(shopifyPayload);

      // Assign to collection
      const collectionId = await shopifyCollections.getOrCreate(collectionName);
      if (collectionId) {
        await shopifyCollections.addProduct(collectionId, created.id);
        logger.info(`📁 "${listing.title}" → collection "${collectionName}"`);
      }

      logger.info(`✅ Listed "${listing.title}" at $${pricing.sellingPrice} (cost: $${rawProduct.price}) [margin: ${pricing.marginPercent}%]`);
      return {
        success: true,
        shopifyId: created.id,
        title: listing.title,
        price: pricing.sellingPrice,
        margin: pricing.marginPercent,
        collection: collectionName,
      };
    } catch (error) {
      logger.error(`${this.name} failed for "${rawProduct.title}"`, { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async _generateListing(product) {
    try {
      return await ai.chatJSON({
        system: `You are an expert Shopify copywriter who writes product listings that convert browsers into buyers.
Your titles are specific, benefit-led, and emotionally resonant — never vague or generic.

TITLE RULES (strictly enforced):
- 40–65 characters
- Lead with the primary benefit or use-case, NOT the product type
- Be specific: include a key detail (material, occasion, who it's for)
- NEVER use: "Premium", "High-Quality", "Amazing", "Perfect", "Great", "Best"
- BAD: "Premium Leather Sandals" | "Brighten Your Outdoors" | "Long-Lasting Power On-The-Go"
- GOOD: "Men's Full-Grain Leather Sandals for Summer Hiking" | "Solar String Lights for Garden Patios & Balconies" | "10,000mAh Power Bank for Camping & Travel"

DESCRIPTION RULES:
- Open with a one-line hook targeting the buyer's desire or pain
- 3–5 bullet benefits (what it does for them, not just what it is)
- Close with a low-risk CTA
- Use clean HTML: <h3>, <ul><li>, <p>`,

        prompt: `Create an optimised Shopify listing for this dropshipped product.

Product details:
- Original supplier title: ${product.title}
- Cost price: $${product.price}
- Sales volume: ${product.sales || 'unknown'} sold
- Supplier rating: ${product.rating || 'N/A'}
- Est. shipping: ${product.shippingDays || '10-20'} days
- Target audience: ${product.targetAudience || 'general consumers'}
- Key selling angle: ${product.adAngle || 'value and quality'}
- Supplier: ${product.supplierName || 'overseas supplier'}

Return ONLY this JSON (no markdown, no backticks):
{
  "title": "...(40-65 chars, benefit-led, specific — see rules above)",
  "collection": "...(ONE of: Home & Garden | Electronics & Gadgets | Fashion & Accessories | Outdoor & Camping | Pet Supplies | Kids & Toys | Beauty & Wellness | Kitchen & Dining | Sports & Fitness | Car Accessories)",
  "descriptionHtml": "<h3>...</h3><p>Hook sentence targeting buyer desire.</p><ul><li>✅ Benefit 1</li><li>✅ Benefit 2</li><li>✅ Benefit 3</li><li>✅ Benefit 4</li></ul><p>Order today with our 30-day guarantee.</p>",
  "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8"],
  "metaTitle": "...(max 60 chars)",
  "metaDescription": "...(max 155 chars, includes a buying reason and implicit CTA)",
  "keySellingPoints": ["point1","point2","point3"]
}`,
        maxTokens: 1200,
      });
    } catch (error) {
      logger.warn(`Listing generation failed, using fallback: ${error.message}`);
      return this._generateFallbackListing(product);
    }
  }

  _calculatePrice(product) {
    const costPrice = parseFloat(product.price) || 0;
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
    const marginPercent = (((sellingPrice - costPrice - shippingBuffer) / sellingPrice) * 100).toFixed(1);

    return {
      sellingPrice: parseFloat(sellingPrice.toFixed(2)),
      comparePrice,
      costPrice,
      marginPercent: parseFloat(marginPercent),
    };
  }

  _generateFallbackListing(product) {
    const rawTitle = product.title || 'Product';
    // Build a descriptive fallback title from the supplier title (trim + capitalise properly)
    const words = rawTitle.toLowerCase().replace(/[^a-z0-9\s\-]/g, ' ').split(/\s+/).filter(Boolean);
    const titleWords = words.slice(0, 8).map(w => w.charAt(0).toUpperCase() + w.slice(1));
    const cleanTitle = titleWords.join(' ').substring(0, 65);

    const collectionName = shopifyCollections.resolveCollectionName(rawTitle);

    return {
      title: cleanTitle,
      collection: collectionName,
      descriptionHtml: `<h3>${cleanTitle}</h3><p>Trusted by thousands of happy customers worldwide.</p><ul><li>✅ Quality materials built to last</li><li>✅ Fast international shipping</li><li>✅ 30-day money-back guarantee</li><li>✅ Friendly customer support</li></ul><p>Order today — risk-free.</p>`,
      tags: ['dropship', 'trending'],
      metaTitle: cleanTitle.substring(0, 60),
      metaDescription: `Buy ${cleanTitle} at the best price. Fast shipping and quality guaranteed.`.substring(0, 155),
      keySellingPoints: ['Quality guaranteed', 'Fast shipping', 'Best price'],
    };
  }

  async bulkProcess(products) {
    // Ensure all collections exist before we start listing
    await shopifyCollections.ensureAllCollections();

    const results = [];
    for (const product of products) {
      const result = await this.processProduct(product);
      results.push(result);
      await new Promise(r => setTimeout(r, 2000)); // respect Shopify rate limits
    }

    const successes = results.filter(r => r.success).length;
    logger.info(`📦 Bulk listing complete: ${successes}/${products.length} successful`);

    // Log collection breakdown
    const byCollection = {};
    results.filter(r => r.success && r.collection).forEach(r => {
      byCollection[r.collection] = (byCollection[r.collection] || 0) + 1;
    });
    if (Object.keys(byCollection).length > 0) {
      logger.info('📁 Products by collection:');
      Object.entries(byCollection)
        .sort((a, b) => b[1] - a[1])
        .forEach(([col, count]) => logger.info(`   ${col}: ${count}`));
    }

    return results;
  }
}

module.exports = new ListingAgent();
