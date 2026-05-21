/**
 * fulfillmentAgent.js — Improved Fulfillment Agent
 *
 * Improvements over original:
 *  1. Idempotency tags — prevents duplicate AliExpress orders on crash/restart
 *  2. Retry logic with exponential back-off on AliExpress submission
 *  3. Per-order error isolation — one bad order no longer kills the whole batch
 *  4. Agent status registry updates (lastRun, lastOrderProcessed, errors)
 *  5. Structured fulfillment receipts stored as order metafields
 *  6. Tracking number auto-write-back to Shopify fulfillment
 */

import { shopifyClient } from '../shopify/client.js';
import { submitOrder, getOrderTracking } from '../suppliers/aliexpress.js';
import { agentRegistry } from '../utils/agentRegistry.js';
import logger from '../utils/logger.js';

const AGENT_NAME = 'fulfillment';
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

// Tags used to track order state on Shopify orders
const TAGS = {
  SUBMITTED: 'dropship-submitted',
  FAILED: 'dropship-failed',
  TRACKING_ADDED: 'dropship-tracking-added',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      logger.warn(`[Fulfillment] Attempt ${i + 1} failed: ${err.message}. Retry in ${delayMs * (i + 1)}ms`);
      await sleep(delayMs * (i + 1));
    }
  }
}

async function addOrderTag(orderId, tag) {
  const order = await shopifyClient.get(`/orders/${orderId}.json?fields=id,tags`);
  const existing = order.data.order.tags || '';
  const tags = existing.split(',').map(t => t.trim()).filter(Boolean);
  if (!tags.includes(tag)) {
    tags.push(tag);
    await shopifyClient.put(`/orders/${orderId}.json`, {
      order: { id: orderId, tags: tags.join(', ') },
    });
  }
}

async function removeOrderTag(orderId, tag) {
  const order = await shopifyClient.get(`/orders/${orderId}.json?fields=id,tags`);
  const tags = (order.data.order.tags || '')
    .split(',')
    .map(t => t.trim())
    .filter(t => t && t !== tag);
  await shopifyClient.put(`/orders/${orderId}.json`, {
    order: { id: orderId, tags: tags.join(', ') },
  });
}

async function saveOrderMetafield(orderId, key, value) {
  await shopifyClient.post(`/orders/${orderId}/metafields.json`, {
    metafield: {
      namespace: 'dropship',
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
      type: typeof value === 'object' ? 'json' : 'single_line_text_field',
    },
  });
}

/**
 * Create a fulfillment record on Shopify with tracking info.
 */
async function createShopifyFulfillment(orderId, lineItemIds, trackingNumber, trackingCompany) {
  const response = await shopifyClient.post(`/orders/${orderId}/fulfillments.json`, {
    fulfillment: {
      location_id: process.env.SHOPIFY_LOCATION_ID,
      tracking_number: trackingNumber,
      tracking_company: trackingCompany,
      notify_customer: true,
      line_items: lineItemIds.map(id => ({ id })),
    },
  });
  return response.data.fulfillment;
}

// ─── Core order processing ────────────────────────────────────────────────────

/**
 * Process a single paid Shopify order.
 * Idempotent — safe to call multiple times for the same order.
 */
async function processSingleOrder(order) {
  const orderId = order.id;
  const orderName = order.name;
  const tags = (order.tags || '').split(',').map(t => t.trim());

  // ── Idempotency check ──────────────────────────────────────────────────────
  if (tags.includes(TAGS.SUBMITTED)) {
    logger.info(`[Fulfillment] Skipping ${orderName} — already submitted to supplier`);
    return { skipped: true, reason: 'already-submitted' };
  }

  if (tags.includes(TAGS.FAILED)) {
    // Only retry failed orders if they haven't exceeded max retries
    const metafields = await shopifyClient.get(
      `/orders/${orderId}/metafields.json?namespace=dropship`
    );
    const retryCount = parseInt(
      metafields.data.metafields.find(m => m.key === 'retry_count')?.value ?? '0'
    );
    if (retryCount >= RETRY_ATTEMPTS) {
      logger.warn(`[Fulfillment] Skipping ${orderName} — max retries (${RETRY_ATTEMPTS}) exceeded`);
      return { skipped: true, reason: 'max-retries-exceeded' };
    }
  }

  logger.info(`[Fulfillment] Processing order ${orderName} (ID: ${orderId})`);

  // ── Build AliExpress order payload ────────────────────────────────────────
  const lineItems = order.line_items.filter(item => {
    // Only submit items that have a supplier URL metafield
    return item.properties?.some(p => p.name === '_supplier_url');
  });

  if (lineItems.length === 0) {
    logger.info(`[Fulfillment] Order ${orderName} has no dropship items — skipping`);
    return { skipped: true, reason: 'no-dropship-items' };
  }

  const supplierPayload = {
    shopifyOrderId: orderId,
    shippingAddress: order.shipping_address,
    items: lineItems.map(item => ({
      supplierUrl: item.properties.find(p => p.name === '_supplier_url')?.value,
      quantity: item.quantity,
      variantSku: item.sku,
    })),
  };

  // ── Submit to AliExpress ──────────────────────────────────────────────────
  let submissionResult;
  try {
    submissionResult = await withRetry(() => submitOrder(supplierPayload));
  } catch (err) {
    logger.error(`[Fulfillment] Failed to submit order ${orderName}: ${err.message}`);
    await addOrderTag(orderId, TAGS.FAILED);

    // Track retry count
    const current = await shopifyClient.get(
      `/orders/${orderId}/metafields.json?namespace=dropship&key=retry_count`
    );
    const count = parseInt(current.data.metafields[0]?.value ?? '0');
    await saveOrderMetafield(orderId, 'retry_count', count + 1);
    await saveOrderMetafield(orderId, 'last_error', err.message);

    return { failed: true, error: err.message };
  }

  // ── Mark as submitted (idempotency gate) ─────────────────────────────────
  await addOrderTag(orderId, TAGS.SUBMITTED);
  if (tags.includes(TAGS.FAILED)) await removeOrderTag(orderId, TAGS.FAILED);

  // Save receipt for reference
  await saveOrderMetafield(orderId, 'supplier_order_id', submissionResult.supplierOrderId);
  await saveOrderMetafield(orderId, 'submitted_at', new Date().toISOString());
  await saveOrderMetafield(orderId, 'receipt', submissionResult);

  logger.info(`[Fulfillment] ✅ Order ${orderName} submitted → Supplier ID: ${submissionResult.supplierOrderId}`);

  return {
    success: true,
    orderId,
    supplierOrderId: submissionResult.supplierOrderId,
  };
}

/**
 * Check tracking numbers for submitted-but-not-yet-tracked orders,
 * and write them back to Shopify fulfillments.
 */
async function syncTrackingNumbers() {
  // Find orders tagged as submitted but not yet tracking-added
  const response = await shopifyClient.get(
    `/orders.json?tag=${TAGS.SUBMITTED}&status=open&limit=50`
  );
  const orders = response.data.orders ?? [];
  const untracked = orders.filter(o =>
    !o.tags.includes(TAGS.TRACKING_ADDED) && o.fulfillments?.length === 0
  );

  logger.info(`[Fulfillment] Checking tracking for ${untracked.length} orders`);

  for (const order of untracked) {
    const supplierOrderId = order.metafields?.find(
      m => m.namespace === 'dropship' && m.key === 'supplier_order_id'
    )?.value;

    if (!supplierOrderId) continue;

    try {
      const tracking = await getOrderTracking(supplierOrderId);
      if (!tracking?.trackingNumber) continue;

      // Write fulfillment to Shopify
      await createShopifyFulfillment(
        order.id,
        order.line_items.map(i => i.id),
        tracking.trackingNumber,
        tracking.carrier ?? 'Other'
      );

      await addOrderTag(order.id, TAGS.TRACKING_ADDED);
      logger.info(`[Fulfillment] 📦 Tracking added to order ${order.name}: ${tracking.trackingNumber}`);
    } catch (err) {
      logger.warn(`[Fulfillment] Could not fetch tracking for ${order.name}: ${err.message}`);
    }
  }
}

// ─── Agent runner ─────────────────────────────────────────────────────────────

export async function runFulfillmentAgent() {
  const startTime = Date.now();
  agentRegistry.update(AGENT_NAME, { status: 'running', lastRun: new Date().toISOString() });

  let processed = 0, skipped = 0, failed = 0;

  try {
    // Fetch all paid, unfulfilled orders
    const response = await shopifyClient.get(
      '/orders.json?financial_status=paid&fulfillment_status=unfulfilled&status=open&limit=250'
    );
    const orders = response.data.orders ?? [];
    logger.info(`[Fulfillment] Found ${orders.length} unfulfilled paid orders`);

    // Process each order independently — errors are isolated per order
    for (const order of orders) {
      const result = await processSingleOrder(order);
      if (result.success) processed++;
      else if (result.skipped) skipped++;
      else failed++;
    }

    // After processing new orders, sync tracking for existing ones
    await syncTrackingNumbers();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[Fulfillment] Done in ${duration}s — processed: ${processed}, skipped: ${skipped}, failed: ${failed}`);

    agentRegistry.update(AGENT_NAME, {
      status: 'idle',
      lastRun: new Date().toISOString(),
      lastStats: { processed, skipped, failed },
    });
  } catch (err) {
    logger.error(`[Fulfillment] Agent run failed: ${err.message}`);
    agentRegistry.update(AGENT_NAME, { status: 'error', lastError: err.message });
  }
}

// Schedule
export function startFulfillmentAgent() {
  runFulfillmentAgent();
  setInterval(runFulfillmentAgent, POLL_INTERVAL_MS);
  logger.info('[Fulfillment] Agent started — polling every 15 minutes');
}
