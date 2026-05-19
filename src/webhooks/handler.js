const crypto = require('crypto');
const logger = require('../utils/logger');
const fulfillmentAgent = require('../agents/fulfillmentAgent');
const shopifyOrders = require('../shopify/orders');

/**
 * Verify Shopify webhook authenticity
 */
function verifyWebhook(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader || !process.env.SHOPIFY_WEBHOOK_SECRET) return false;

  const body = req.rawBody || JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(body, 'utf8')
    .digest('base64');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

/**
 * Handle incoming Shopify webhooks
 */
async function handleWebhook(req, res) {
  const topic = req.headers['x-shopify-topic'];
  const shop = req.headers['x-shopify-shop-domain'];

  // Verify webhook authenticity
  if (!verifyWebhook(req)) {
    logger.warn(`Invalid webhook signature from ${shop}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({ received: true }); // Respond immediately

  const data = req.body;
  logger.info(`📨 Webhook received: ${topic} from ${shop}`);

  try {
    switch (topic) {
      // New order paid → trigger fulfillment
      case 'orders/paid':
        logger.info(`💳 New paid order: #${data.order_number} ($${data.total_price})`);
        if (process.env.AUTO_FULFILL_ORDERS === 'true') {
          setTimeout(async () => {
            try {
              await fulfillmentAgent._processOrder(data);
            } catch (error) {
              logger.error(`Webhook fulfillment failed for order ${data.id}`, { error: error.message });
            }
          }, 3000);
        }
        break;

      // Order created
      case 'orders/create':
        logger.info(`🛒 New order created: #${data.order_number}`);
        break;

      // Order cancelled → alert
      case 'orders/cancelled':
        logger.warn(`❌ Order cancelled: #${data.order_number}`);
        break;

      // Refund created
      case 'refunds/create':
        logger.warn(`💸 Refund for order ${data.order_id}: $${data.transactions?.[0]?.amount}`);
        break;

      // Product updated externally
      case 'products/update':
        logger.info(`📝 Product updated externally: ${data.id}`);
        break;

      // Inventory updated
      case 'inventory_levels/update':
        logger.debug(`📦 Inventory update: item ${data.inventory_item_id} → ${data.available} units`);
        break;

      // App uninstalled
      case 'app/uninstalled':
        logger.warn(`⚠️ App uninstalled from ${shop}`);
        break;

      default:
        logger.debug(`Unhandled webhook topic: ${topic}`);
    }
  } catch (error) {
    logger.error(`Webhook handler error for topic ${topic}`, { error: error.message });
  }
}

/**
 * Register webhooks with Shopify
 */
async function registerWebhooks(baseUrl) {
  const { getShopifyClient } = require('../shopify/client');
  const shopify = getShopifyClient();

  const webhooks = [
    { topic: 'orders/paid', address: `${baseUrl}/webhooks/orders/paid` },
    { topic: 'orders/create', address: `${baseUrl}/webhooks/orders/create` },
    { topic: 'orders/cancelled', address: `${baseUrl}/webhooks/orders/cancelled` },
    { topic: 'refunds/create', address: `${baseUrl}/webhooks/refunds/create` },
    { topic: 'products/update', address: `${baseUrl}/webhooks/products/update` },
    { topic: 'inventory_levels/update', address: `${baseUrl}/webhooks/inventory/update` }
  ];

  const results = [];

  for (const webhook of webhooks) {
    try {
      // Check if already registered
      const existing = await shopify.webhook.list({ topic: webhook.topic });
      const alreadyExists = existing.some(w => w.address === webhook.address);

      if (!alreadyExists) {
        const created = await shopify.webhook.create({
          ...webhook,
          format: 'json'
        });
        logger.info(`✅ Webhook registered: ${webhook.topic}`);
        results.push({ topic: webhook.topic, status: 'created', id: created.id });
      } else {
        logger.info(`ℹ️  Webhook already exists: ${webhook.topic}`);
        results.push({ topic: webhook.topic, status: 'exists' });
      }
    } catch (error) {
      logger.error(`Failed to register webhook: ${webhook.topic}`, { error: error.message });
      results.push({ topic: webhook.topic, status: 'error', error: error.message });
    }
  }

  return results;
}

module.exports = { handleWebhook, registerWebhooks, verifyWebhook };
