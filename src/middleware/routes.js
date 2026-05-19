const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { handleWebhook } = require('../webhooks/handler');

// Agents
const productResearchAgent = require('../agents/productResearchAgent');
const listingAgent         = require('../agents/listingAgent');
const pricingAgent         = require('../agents/pricingAgent');
const fulfillmentAgent     = require('../agents/fulfillmentAgent');
const inventoryAgent       = require('../agents/inventoryAgent');
const supportAgent         = require('../agents/supportAgent');

// Utilities
const shopifyOrders   = require('../shopify/orders');
const shopifyProducts = require('../shopify/products');
const analytics       = require('../utils/analytics');

// ─── Webhooks ─────────────────────────────────────────────────────────────────
router.post('/webhooks/:resource/:event', (req, res) => {
  req.headers['x-shopify-topic'] = `${req.params.resource}/${req.params.event}`;
  handleWebhook(req, res);
});

// ─── Agent triggers ───────────────────────────────────────────────────────────
router.post('/agents/research', async (req, res) => {
  try {
    logger.info('🔍 Manual: Product Research triggered');
    const products = await productResearchAgent.run();
    res.json({ success: true, productsFound: products.length, products });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/agents/list-products', async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products)) return res.status(400).json({ error: 'products array required' });
    const results = await listingAgent.bulkProcess(products);
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/agents/research-and-list', async (req, res) => {
  res.json({ success: true, message: 'Research + Listing started in background' });
  try {
    const products = await productResearchAgent.run();
    if (products.length > 0) await listingAgent.bulkProcess(products);
  } catch (e) {
    logger.error('Background research+list failed', { error: e.message });
  }
});

router.post('/agents/pricing', async (req, res) => {
  try {
    const results = await pricingAgent.run();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/agents/fulfillment', async (req, res) => {
  try {
    const results = await fulfillmentAgent.run();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/agents/inventory', async (req, res) => {
  try {
    const results = await inventoryAgent.run();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/agents/support', async (req, res) => {
  try {
    const results = await supportAgent.run();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Runtime AI provider switch ───────────────────────────────────────────────
router.post('/agents/switch-provider', (req, res) => {
  const { provider } = req.body;
  const allowed = ['claude', 'grok'];
  if (!provider || !allowed.includes(provider.toLowerCase())) {
    return res.status(400).json({ error: `Invalid provider. Allowed: ${allowed.join(', ')}` });
  }
  process.env.AI_PROVIDER = provider.toLowerCase();
  // Clear module cache → re-init singleton with new provider
  delete require.cache[require.resolve('../utils/aiProvider')];
  const ai = require('../utils/aiProvider');
  logger.info(`🔄 AI provider switched to: ${ai.providerName}`);
  res.json({ success: true, provider: ai.providerName, model: ai.modelName });
});

// ─── Dashboard data ───────────────────────────────────────────────────────────
router.get('/dashboard/stats', async (req, res) => {
  try {
    const days = parseInt(req.query.days || 30);
    const [stats, products] = await Promise.all([
      shopifyOrders.getRevenueStats(days),
      shopifyProducts.getAllDropshipProducts()
    ]);
    res.json({
      revenue: stats,
      products: {
        total: products.length,
        active: products.filter(p => p.status === 'active').length,
        draft:  products.filter(p => p.status === 'draft').length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/dashboard/orders', async (req, res) => {
  try {
    const orders = await shopifyOrders.getUnfulfilledOrders(20);
    res.json({ orders, count: orders.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics/report', async (req, res) => {
  try {
    const days = parseInt(req.query.days || 30);
    const report = await analytics.getProfitReport(days);
    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/analytics/insights', async (req, res) => {
  try {
    const days = parseInt(req.query.days || 30);
    const report = await analytics.getProfitReport(days);
    const insights = await analytics.getAIInsights(report);
    res.json({ success: true, insights, report: report?.summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Product management ───────────────────────────────────────────────────────
router.get('/products', async (req, res) => {
  try {
    const products = await shopifyProducts.getAllDropshipProducts();
    res.json({ products, count: products.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/products/:id/price', async (req, res) => {
  try {
    const { variantId, price, comparePrice } = req.body;
    if (!variantId || !price) return res.status(400).json({ error: 'variantId and price required' });
    await shopifyProducts.updateVariantPrice(variantId, parseFloat(price), comparePrice ? parseFloat(comparePrice) : null);
    res.json({ success: true, variantId, price });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const { getShopifyClient } = require('../shopify/client');
    await getShopifyClient().product.delete(req.params.id);
    res.json({ success: true, deleted: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  const ai = require('../utils/aiProvider');
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
    shop: process.env.SHOPIFY_SHOP_NAME,
    autoFulfill: process.env.AUTO_FULFILL_ORDERS === 'true',
    autoPublish: process.env.AUTO_PUBLISH_PRODUCTS === 'true',
    aiProvider: ai.providerName,
    aiModel: ai.modelName,
    version: require('../../package.json').version
  });
});

module.exports = router;
