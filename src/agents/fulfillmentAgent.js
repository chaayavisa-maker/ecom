const ai = require('../utils/aiProvider');
const shopifyOrders = require('../shopify/orders');
const { cjDropshipping } = require('../suppliers/aliexpress');
const logger = require('../utils/logger');

class FulfillmentAgent {
  constructor() {
    this.name = 'FulfillmentAgent';
    this.processedOrders = new Set();
  }

  async run() {
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);
    if (process.env.AUTO_FULFILL_ORDERS !== 'true') {
      logger.info('⏸️  Auto-fulfillment disabled. Skipping.');
      return { processed: 0, skipped: 0 };
    }

    try {
      const orders = await shopifyOrders.getUnfulfilledOrders(50);
      logger.info(`📦 ${orders.length} unfulfilled orders found`);
      const results = { processed: 0, failed: 0, skipped: 0 };

      for (const order of orders) {
        if (this.processedOrders.has(order.id)) { results.skipped++; continue; }
        try {
          const result = await this._processOrder(order);
          if (result.success) { results.processed++; this.processedOrders.add(order.id); }
          else results.failed++;
        } catch (error) {
          logger.error(`Failed to process order ${order.id}`, { error: error.message });
          results.failed++;
        }
        await this._sleep(2000);
      }

      logger.info(`✅ ${this.name} complete:`, results);
      return results;
    } catch (error) {
      logger.error(`${this.name} failed`, { error: error.message });
      throw error;
    }
  }

  async _processOrder(order) {
    logger.info(`📦 Processing order #${order.order_number} ($${order.total_price})`);
    const enrichedOrder = await shopifyOrders.getOrderWithSupplierInfo(order.id);
    const itemsWithSupplier = enrichedOrder.line_items.filter(item => item.supplierInfo?.supplier_id);

    if (itemsWithSupplier.length === 0) {
      await shopifyOrders.addOrderNote(order.id, '⚠️ AUTO-AGENT: No supplier info found. Manual fulfillment required.');
      return { success: false, reason: 'no_supplier_info' };
    }

    const decision = await this._getFulfillmentDecision(enrichedOrder);

    if (decision.action === 'skip') {
      await shopifyOrders.addOrderNote(order.id, `⚠️ AUTO-AGENT: Skipped — ${decision.reason}`);
      return { success: false, reason: decision.reason };
    }

    if (decision.action === 'fulfill_manual') {
      await shopifyOrders.addOrderNote(order.id, `📋 AUTO-AGENT: Manual fulfillment recommended. ${decision.reason}`);
      return { success: false, reason: 'manual_recommended' };
    }

    try {
      const supplierOrder = await this._placeSupplierOrder(enrichedOrder);
      if (supplierOrder.success) {
        await shopifyOrders.fulfillOrder(order.id, {
          trackingNumber: supplierOrder.trackingNumber || '',
          trackingUrl: supplierOrder.trackingUrl || '',
          carrier: supplierOrder.carrier || 'Standard Shipping'
        });
        await shopifyOrders.addOrderNote(order.id,
          `✅ AUTO-AGENT: Fulfilled via ${supplierOrder.supplier}. Supplier Order: ${supplierOrder.supplierId}. Tracking: ${supplierOrder.trackingNumber || 'Pending'}`
        );
        logger.info(`✅ Order #${order.order_number} fulfilled via ${supplierOrder.supplier}`);
        return { success: true, supplierOrder };
      }
    } catch (supplierError) {
      logger.error(`Supplier order failed for #${order.order_number}`, { error: supplierError.message });
    }

    await shopifyOrders.addOrderNote(order.id,
      `❌ AUTO-AGENT: Automatic fulfillment failed. Please fulfill manually.\nSupplier URL: ${itemsWithSupplier[0]?.supplierInfo?.supplier_url || 'N/A'}`
    );
    return { success: false, reason: 'supplier_error' };
  }

  async _getFulfillmentDecision(order) {
    try {
      const orderSummary = {
        orderNumber: order.order_number,
        totalPrice: order.total_price,
        currency: order.currency,
        customer: { country: order.shipping_address?.country_code, city: order.shipping_address?.city },
        items: order.line_items.map(item => ({
          title: item.title, quantity: item.quantity, price: item.price,
          hasSupplierInfo: !!item.supplierInfo?.supplier_id,
          supplierName: item.supplierInfo?.supplier_name
        }))
      };

      return await ai.chatJSON({
        system: `You are a dropshipping fulfillment AI. Analyze orders and decide how to fulfill them.`,
        prompt: `Analyze this order and decide on fulfillment action.

Order: ${JSON.stringify(orderSummary, null, 2)}

Watch for red flags: unusually high quantities, suspicious addresses, pricing mismatches.

Return: { "action": "auto_fulfill" | "fulfill_manual" | "skip", "reason": "...", "priority": "high" | "normal" | "low" }`,
        maxTokens: 400
      });
    } catch (error) {
      logger.warn('AI fulfillment decision failed, defaulting to auto_fulfill');
      return { action: 'auto_fulfill', reason: 'Default', priority: 'normal' };
    }
  }

  async _placeSupplierOrder(order) {
    const shippingAddress = order.shipping_address;
    const firstItem = order.line_items[0];
    const supplierName = firstItem?.supplierInfo?.supplier_name || 'AliExpress';

    const orderData = {
      shopifyOrderId: String(order.id),
      shipping: {
        name: shippingAddress.name, address1: shippingAddress.address1,
        address2: shippingAddress.address2 || '', city: shippingAddress.city,
        province: shippingAddress.province, zip: shippingAddress.zip,
        country: shippingAddress.country, countryCode: shippingAddress.country_code,
        phone: shippingAddress.phone || order.phone || ''
      },
      items: order.line_items.filter(i => i.supplierInfo?.supplier_id).map(item => ({
        supplierId: item.supplierInfo.supplier_id, variantSku: item.sku,
        quantity: item.quantity, supplierUrl: item.supplierInfo.supplier_url
      }))
    };

    if (supplierName === 'CJ Dropshipping') {
      try {
        const result = await cjDropshipping.placeOrder(orderData);
        return { success: true, supplier: 'CJ Dropshipping', supplierId: result.cjOrderId, trackingNumber: result.trackingNumber, carrier: 'CJ Packet' };
      } catch (error) {
        logger.warn('CJ auto-order failed, falling back to manual');
      }
    }

    const supplierUrl = firstItem?.supplierInfo?.supplier_url;
    logger.info(`📋 AliExpress order requires manual placement. URL: ${supplierUrl}`);
    return { success: true, supplier: 'AliExpress (Manual)', supplierId: `MANUAL-${order.order_number}`, trackingNumber: null };
  }

  async updateTracking() {
    logger.info(`🔍 ${this.name}: Checking tracking updates...`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = new FulfillmentAgent();
