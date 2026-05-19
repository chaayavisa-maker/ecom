const { getShopifyClient } = require('./client');
const logger = require('../utils/logger');

class ShopifyOrders {
  constructor() {
    this.shopify = getShopifyClient();
  }

  /**
   * Get unfulfilled orders that need processing
   */
  async getUnfulfilledOrders(limit = 50) {
    try {
      return await this.shopify.order.list({
        status: 'open',
        fulfillment_status: 'unfulfilled',
        financial_status: 'paid',
        limit
      });
    } catch (error) {
      logger.error('Failed to fetch unfulfilled orders', { error: error.message });
      throw error;
    }
  }

  /**
   * Get a single order with full details
   */
  async getOrder(orderId) {
    try {
      return await this.shopify.order.get(orderId);
    } catch (error) {
      logger.error(`Failed to get order ${orderId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Mark order as fulfilled with tracking
   */
  async fulfillOrder(orderId, trackingInfo = {}) {
    try {
      const order = await this.getOrder(orderId);
      const locationId = (await this.shopify.location.list())[0]?.id;

      if (!locationId) throw new Error('No Shopify location found');

      const lineItems = order.line_items.map(item => ({
        id: item.id,
        quantity: item.fulfillable_quantity
      })).filter(item => item.quantity > 0);

      if (lineItems.length === 0) {
        logger.warn(`Order ${orderId} has no fulfillable items`);
        return null;
      }

      const fulfillment = await this.shopify.fulfillment.createV2({
        fulfillment: {
          line_items_by_fulfillment_order: [{
            fulfillment_order_id: order.id,
            fulfillment_order_line_items: lineItems
          }],
          tracking_info: {
            number: trackingInfo.trackingNumber || '',
            url: trackingInfo.trackingUrl || '',
            company: trackingInfo.carrier || 'AliExpress Standard Shipping'
          },
          notify_customer: true,
          location_id: locationId
        }
      });

      logger.info(`✅ Order ${orderId} fulfilled with tracking: ${trackingInfo.trackingNumber}`);
      return fulfillment;
    } catch (error) {
      logger.error(`Failed to fulfill order ${orderId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Add note to order
   */
  async addOrderNote(orderId, note) {
    try {
      return await this.shopify.order.update(orderId, {
        note: note,
        note_attributes: [
          { name: 'dropship_processed', value: 'true' },
          { name: 'processed_at', value: new Date().toISOString() }
        ]
      });
    } catch (error) {
      logger.error(`Failed to add note to order ${orderId}`, { error: error.message });
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId, reason = 'other') {
    try {
      return await this.shopify.order.cancel(orderId, { reason });
    } catch (error) {
      logger.error(`Failed to cancel order ${orderId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Create refund for order
   */
  async refundOrder(orderId, amount, note = '') {
    try {
      const refund = await this.shopify.refund.create(orderId, {
        note,
        notify: true,
        transactions: [{
          kind: 'refund',
          amount: amount.toFixed(2)
        }]
      });
      logger.info(`💸 Refund created for order ${orderId}: $${amount}`);
      return refund;
    } catch (error) {
      logger.error(`Failed to refund order ${orderId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get order line items with product supplier info
   */
  async getOrderWithSupplierInfo(orderId) {
    try {
      const order = await this.getOrder(orderId);
      const enrichedItems = [];

      for (const item of order.line_items) {
        const metafields = await this.shopify.metafield.list({
          metafield: {
            owner_resource: 'product',
            owner_id: item.product_id
          }
        });

        const supplierMeta = {};
        metafields.forEach(m => {
          if (m.namespace === 'dropship') {
            supplierMeta[m.key] = m.value;
          }
        });

        enrichedItems.push({
          ...item,
          supplierInfo: supplierMeta
        });
      }

      return { ...order, line_items: enrichedItems };
    } catch (error) {
      logger.error(`Failed to enrich order ${orderId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get revenue stats
   */
  async getRevenueStats(days = 30) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      const orders = await this.shopify.order.list({
        status: 'any',
        financial_status: 'paid',
        created_at_min: since.toISOString(),
        limit: 250
      });

      const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price), 0);
      const totalOrders = orders.length;
      const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

      return {
        totalRevenue: totalRevenue.toFixed(2),
        totalOrders,
        avgOrderValue: avgOrderValue.toFixed(2),
        period: `${days} days`
      };
    } catch (error) {
      logger.error('Failed to get revenue stats', { error: error.message });
      return { totalRevenue: 0, totalOrders: 0, avgOrderValue: 0 };
    }
  }
}

module.exports = new ShopifyOrders();
