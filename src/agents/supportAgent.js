const ai = require('../utils/aiProvider');
const { getShopifyClient } = require('../shopify/client');
const logger = require('../utils/logger');

/**
 * SupportAgent — reads Shopify customer notes / order tags and drafts
 * reply templates for common dropshipping inquiries:
 *   - Where is my order? (WISMO)
 *   - Refund / return requests
 *   - Wrong / damaged item
 *   - Cancellation requests
 *
 * Because Shopify's built-in email API is limited, the agent writes
 * its draft replies as order notes so your support tool (Gorgias,
 * Freshdesk, Gmail, etc.) can pick them up.
 */
class SupportAgent {
  constructor() {
    this.name = 'SupportAgent';
    this.shopify = getShopifyClient();
  }

  async run() {
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);
    const orders = await this._getOrdersNeedingSupport();
    const results = { handled: 0, skipped: 0, errors: 0 };

    for (const order of orders) {
      try {
        const handled = await this._handleOrder(order);
        if (handled) results.handled++;
        else results.skipped++;
      } catch (err) {
        logger.error(`Support handling failed for order ${order.id}`, { error: err.message });
        results.errors++;
      }
    }

    logger.info(`✅ ${this.name} complete:`, results);
    return results;
  }

  /** Pull open orders that have a customer note but no AGENT-REPLIED tag */
  async _getOrdersNeedingSupport() {
    try {
      const orders = await this.shopify.order.list({
        status: 'open',
        limit: 50,
        fields: 'id,order_number,customer,note,tags,total_price,created_at,line_items,shipping_address,fulfillment_status'
      });
      return orders.filter(o => o.note && o.note.trim() && !o.tags.includes('agent-replied'));
    } catch (err) {
      logger.error('Failed to fetch orders for support', { error: err.message });
      return [];
    }
  }

  async _handleOrder(order) {
    const inquiry = order.note?.trim();
    if (!inquiry) return false;

    logger.info(`💬 Support: Order #${order.order_number} — "${inquiry.substring(0, 60)}..."`);

    const context = {
      orderNumber: order.order_number,
      orderTotal: order.total_price,
      fulfillmentStatus: order.fulfillment_status || 'unfulfilled',
      customerName: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : 'Customer',
      items: order.line_items.map(i => i.title).join(', '),
      shippingCountry: order.shipping_address?.country || 'N/A',
      createdAt: order.created_at,
      inquiry
    };

    const draft = await this._generateReply(context);
    if (!draft) return false;

    // Write draft reply as order note (prefix so human agents can spot it)
    const noteText = [
      `--- AGENT DRAFT REPLY (${new Date().toISOString()}) ---`,
      draft,
      `--- END DRAFT ---`,
      '',
      `Original customer note: ${inquiry}`
    ].join('\n');

    await this.shopify.order.update(order.id, {
      note: noteText,
      tags: [...new Set([...order.tags.split(',').map(t => t.trim()), 'agent-replied'])].filter(Boolean).join(', ')
    });

    logger.info(`📧 Draft reply written for order #${order.order_number}`);
    return true;
  }

  async _generateReply(context) {
    try {
      return await ai.chat({
        system: `You are a professional, empathetic customer support agent for an online dropshipping store.
Write concise, friendly email replies (max 150 words). Never promise specific dates you don't know.
Be honest: if an item ships from overseas (15-30 days), say so warmly. Always offer a resolution.
Sign off as "The Support Team".`,
        prompt: `Write a customer support reply for this inquiry:

Order: #${context.orderNumber}
Customer: ${context.customerName}
Order Total: $${context.orderTotal}
Items: ${context.items}
Fulfillment Status: ${context.fulfillmentStatus}
Shipping Country: ${context.shippingCountry}
Order Date: ${new Date(context.createdAt).toDateString()}

Customer's message:
"${context.inquiry}"

Write a helpful, professional reply addressing their concern directly.`,
        maxTokens: 400
      });
    } catch (err) {
      logger.error('Support reply generation failed', { error: err.message });
      return null;
    }
  }
}

module.exports = new SupportAgent();
