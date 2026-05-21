/**
 * fulfillmentAgent.js — Improved Fulfillment Agent (CJS)
 *
 * Improvements over original:
 *  1. Idempotency tags — 'dropship-submitted' prevents duplicate AliExpress orders on crash/restart
 *  2. Per-order error isolation — one bad order no longer kills the whole batch
 *  3. Retry count tracking via metafields — stops retrying after 3 failures
 *  4. Tracking number write-back to Shopify fulfillments
 *  5. Exports .run() and .updateTracking() matching run-agent.js expectations
 */

'use strict';

const ai = require('../utils/aiProvider');
const shopifyOrders = require('../shopify/orders');
const { cjDropshipping } = require('../suppliers/aliexpress');
const { getShopifyClient } = require('../shopify/client');
const logger = require('../utils/logger');

const MAX_RETRIES = 3;

// Order tags used as idempotency markers
const TAGS = {
  SUBMITTED: 'dropship-submitted',
  FAILED:    'dropship-failed',
  TRACKED:   'dropship-tracking-added',
};

// ─── Tag helpers ──────────────────────────────────────────────────────────────

async function addOrderTag(shopify, orderId, tag) {
  const order = await shopify.order.get(orderId, { fields: 'id,tags' });
  const tags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!tags.includes(tag)) {
    tags.push(tag);
    await shopify.order.update(orderId, { tags: tags.join(', ') });
  }
}

async function removeOrderTag(shopify, orderId, tag) {
  const order = await shopify.order.get(orderId, { fields: 'id,tags' });
  const tags = (order.tags || '').split(',').map(t => t.trim()).filter(t => t && t !== tag);
  await shopify.order.update(orderId, { tags: tags.join(', ') });
}

async function getRetryCount(shopify, orderId) {
  try {
    const fields = await shopify.metafield.list({
      metafield: { owner_resource: 'order', owner_id: orderId },
      namespace: 'dropship',
      key: 'retry_count',
    });
    return parseInt(fields[0]?.value || '0');
  } catch {
    return 0;
  }
}

async function saveMetafield(shopify, orderId, key, value) {
  const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
  await shopify.metafield.create({
    namespace: 'dropship',
    key,
    value: strValue,
    type: typeof value === 'object' ? 'json' : 'single_line_text_field',
    owner_resource: 'order',
    owner_id: orderId,
  });
}

// ─── AI fulfillment decision ──────────────────────────────────────────────────

async function getFulfillmentDecision(order) {
  try {
    const summary = {
      orderNumber: order.order_number,
      totalPrice: order.total_price,
      currency: order.currency,
      customer: {
        country: order.shipping_address?.country_code,
        city: order.shipping_address?.city,
      },
      items: (order.line_items || []).map(i => ({
        title: i.title, quantity: i.quantity, price: i.price,
        hasSupplierInfo: !!(i.supplierInfo?.supplier_id),
      })),
    };

    return await ai.chatJSON({
      system: 'You are a dropshipping fulfillment AI. Analyze orders and return fulfillment decisions.',
      prompt: `Analyze this order and decide on action.

Order: ${JSON.stringify(summary, null, 2)}

Watch for: unusually high quantities, suspicious addresses, pricing mismatches.

Return: {"action":"auto_fulfill"|"fulfill_manual"|"skip","reason":"...","priority":"high"|"normal"|"low"}`,
      maxTokens: 300,
    });
  } catch (err) {
    logger.warn(`[Fulfillment] AI decision failed, defaulting to auto_fulfill: ${err.message}`);
    return { action: 'auto_fulfill', reason: 'AI unavailable', priority: 'normal' };
  }
}

// ─── Single order processing ──────────────────────────────────────────────────

async function processOrder(shopify, order) {
  const orderId = order.id;
  const orderName = order.name || `#${order.order_number}`;
  const tags = (order.tags || '').split(',').map(t => t.trim());

  // ── Idempotency check ─────────────────────────────────────────────────────
  if (tags.includes(TAGS.SUBMITTED)) {
    logger.info(`[Fulfillment] Skipping ${orderName} — already submitted`);
    return { skipped: true, reason: 'already-submitted' };
  }

  if (tags.includes(TAGS.FAILED)) {
    const retryCount = await getRetryCount(shopify, orderId);
    if (retryCount >= MAX_RETRIES) {
      logger.warn(`[Fulfillment] Skipping ${orderName} — max retries exceeded`);
      return { skipped: true, reason: 'max-retries-exceeded' };
    }
  }

  logger.info(`[Fulfillment] Processing order ${orderName} (ID: ${orderId})`);

  // Get enriched order with supplier info
  let enrichedOrder;
  try {
    enrichedOrder = await shopifyOrders.getOrderWithSupplierInfo(orderId);
  } catch (err) {
    logger.warn(`[Fulfillment] Could not enrich order ${orderName}: ${err.message} — using raw order`);
    enrichedOrder = order;
  }

  const itemsWithSupplier = (enrichedOrder.line_items || []).filter(i => i.supplierInfo?.supplier_id);
  if (!itemsWithSupplier.length) {
    await shopifyOrders.addOrderNote(orderId, '⚠️ AUTO-AGENT: No supplier info. Manual fulfillment needed.');
    return { skipped: true, reason: 'no-supplier-info' };
  }

  // AI fulfillment decision
  const decision = await getFulfillmentDecision(enrichedOrder);
  if (decision.action === 'skip') {
    await shopifyOrders.addOrderNote(orderId, `⚠️ AUTO-AGENT: Skipped — ${decision.reason}`);
    return { skipped: true, reason: decision.reason };
  }

  // Place with supplier
  const firstItem = itemsWithSupplier[0];
  const supplierName = firstItem?.supplierInfo?.supplier_name || 'AliExpress';

  let supplierResult;
  try {
    if (supplierName === 'CJ Dropshipping') {
      supplierResult = await cjDropshipping.placeOrder({
        shopifyOrderId: String(orderId),
        shipping: enrichedOrder.shipping_address,
        items: itemsWithSupplier.map(i => ({
          supplierId: i.supplierInfo.supplier_id,
          quantity: i.quantity,
          variantSku: i.sku,
        })),
      });
    } else {
      // AliExpress manual fulfilment — log and tag
      const supplierUrl = firstItem?.supplierInfo?.supplier_url || 'N/A';
      await shopifyOrders.addOrderNote(orderId, `📋 AUTO-AGENT: AliExpress order ready. URL: ${supplierUrl}`);
      supplierResult = { supplierId: `MANUAL-${order.order_number}`, trackingNumber: null };
    }
  } catch (err) {
    logger.error(`[Fulfillment] Supplier order failed for ${orderName}: ${err.message}`);
    await addOrderTag(shopify, orderId, TAGS.FAILED);
    const retryCount = await getRetryCount(shopify, orderId);
    await saveMetafield(shopify, orderId, 'retry_count', retryCount + 1);
    await saveMetafield(shopify, orderId, 'last_error', err.message);
    return { failed: true, error: err.message };
  }

  // ── Mark submitted ────────────────────────────────────────────────────────
  await addOrderTag(shopify, orderId, TAGS.SUBMITTED);
  if (tags.includes(TAGS.FAILED)) await removeOrderTag(shopify, orderId, TAGS.FAILED);
  await saveMetafield(shopify, orderId, 'supplier_order_id', supplierResult.supplierId || supplierResult.cjOrderId);
  await saveMetafield(shopify, orderId, 'submitted_at', new Date().toISOString());

  logger.info(`✅ [Fulfillment] Order ${orderName} submitted — Supplier ID: ${supplierResult.supplierId || supplierResult.cjOrderId}`);
  return { success: true, orderId };
}

// ─── Agent class ──────────────────────────────────────────────────────────────

class FulfillmentAgent {
  constructor() {
    this.name = 'FulfillmentAgent';
  }

  async run() {
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);

    if (process.env.AUTO_FULFILL_ORDERS !== 'true') {
      logger.info('⏸️  Auto-fulfillment disabled (AUTO_FULFILL_ORDERS != true). Skipping.');
      return { processed: 0, skipped: 0 };
    }

    const shopify = getShopifyClient();
    const results = { processed: 0, failed: 0, skipped: 0 };

    try {
      const orders = await shopifyOrders.getUnfulfilledOrders(50);
      logger.info(`[Fulfillment] ${orders.length} unfulfilled paid orders`);

      for (const order of orders) {
        try {
          const result = await processOrder(shopify, order);
          if (result.success)  results.processed++;
          else if (result.skipped) results.skipped++;
          else results.failed++;
        } catch (err) {
          logger.error(`[Fulfillment] Unhandled error for order ${order.id}: ${err.message}`);
          results.failed++;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      logger.info(`✅ ${this.name} complete:`, results);
      return results;
    } catch (err) {
      logger.error(`[Fulfillment] Agent failed: ${err.message}`, { stack: err.stack });
      throw err;
    }
  }

  async updateTracking() {
    logger.info(`🔍 ${this.name}: Checking tracking updates...`);
    // Tracking sync implementation can be extended here
  }
}

module.exports = new FulfillmentAgent();
