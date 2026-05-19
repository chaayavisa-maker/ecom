const Shopify = require('shopify-api-node');
const logger  = require('../utils/logger');

let shopifyInstance = null;

function getShopifyClient() {
  if (shopifyInstance) return shopifyInstance;

  const shopName    = process.env.SHOPIFY_SHOP_NAME;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shopName) throw new Error('SHOPIFY_SHOP_NAME is missing from .env');

  // Support both auth methods:
  //   Modern OAuth app  → SHOPIFY_ACCESS_TOKEN (shpat_ or online token)
  //   Legacy private    → SHOPIFY_ACCESS_TOKEN (same field)
  if (!accessToken) {
    throw new Error(
      'SHOPIFY_ACCESS_TOKEN is missing.\n' +
      'Run:  npm run auth   to generate it from your Client ID + Secret.'
    );
  }

  shopifyInstance = new Shopify({
    shopName:    shopName.replace(/https?:\/\//, '').replace(/\/$/, ''),
    accessToken: accessToken,
    apiVersion:  '2024-01',
    autoLimit:   true
  });

  shopifyInstance.on('callLimits', (limits) => {
    if (limits.remaining < 5) {
      logger.warn(`Shopify rate limit low: ${limits.remaining}/${limits.max} remaining`);
    }
  });

  logger.info(`Shopify client ready: ${shopName}`);
  return shopifyInstance;
}

/**
 * Reset the singleton — used after OAuth token is freshly written to .env
 */
function resetShopifyClient() {
  shopifyInstance = null;
  logger.info('Shopify client reset — will reinitialize on next call');
}

module.exports = { getShopifyClient, resetShopifyClient };
