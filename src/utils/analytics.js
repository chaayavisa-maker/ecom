const { getShopifyClient } = require('../shopify/client');
const ai = require('../utils/aiProvider');
const logger = require('../utils/logger');

class Analytics {
  constructor() {
    this.shopify = getShopifyClient();
  }

  /**
   * Full profit report for the last N days
   */
  async getProfitReport(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    let allOrders = [];
    try {
      let params = {
        status: 'any',
        financial_status: 'paid',
        created_at_min: since.toISOString(),
        limit: 250,
        fields: 'id,order_number,total_price,subtotal_price,total_discounts,total_tax,line_items,created_at,financial_status,fulfillment_status,refunds'
      };
      do {
        const batch = await this.shopify.order.list(params);
        allOrders.push(...batch);
        params = batch.nextPageParameters;
      } while (params);
    } catch (err) {
      logger.error('Failed to fetch orders for analytics', { error: err.message });
      return null;
    }

    // Calculate revenue metrics
    const revenue = allOrders.reduce((s, o) => s + parseFloat(o.total_price), 0);
    const refunds = allOrders.reduce((s, o) => {
      const refundTotal = (o.refunds || []).reduce((rs, r) =>
        rs + (r.transactions || []).reduce((ts, t) => ts + parseFloat(t.amount || 0), 0), 0);
      return s + refundTotal;
    }, 0);
    const netRevenue = revenue - refunds;

    // Product-level breakdown
    const productMap = {};
    for (const order of allOrders) {
      for (const item of order.line_items) {
        const key = item.product_id;
        if (!productMap[key]) {
          productMap[key] = { title: item.title, units: 0, revenue: 0, product_id: key };
        }
        productMap[key].units += item.quantity;
        productMap[key].revenue += parseFloat(item.price) * item.quantity;
      }
    }

    const topProducts = Object.values(productMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Daily breakdown
    const dailyMap = {};
    for (const order of allOrders) {
      const day = order.created_at.substring(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { revenue: 0, orders: 0 };
      dailyMap[day].revenue += parseFloat(order.total_price);
      dailyMap[day].orders += 1;
    }

    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, ...d }));

    const fulfilled = allOrders.filter(o => o.fulfillment_status === 'fulfilled').length;
    const unfulfilled = allOrders.filter(o => o.fulfillment_status !== 'fulfilled').length;

    return {
      period: `${days} days`,
      generatedAt: new Date().toISOString(),
      summary: {
        totalOrders: allOrders.length,
        fulfilledOrders: fulfilled,
        unfulfilledOrders: unfulfilled,
        fulfillmentRate: allOrders.length ? ((fulfilled / allOrders.length) * 100).toFixed(1) + '%' : '0%',
        grossRevenue: revenue.toFixed(2),
        totalRefunds: refunds.toFixed(2),
        netRevenue: netRevenue.toFixed(2),
        avgOrderValue: allOrders.length ? (revenue / allOrders.length).toFixed(2) : '0.00'
      },
      topProducts,
      daily
    };
  }

  /**
   * AI-generated insights from the analytics data
   */
  async getAIInsights(report) {
    if (!report) return 'No data available.';
    try {
      return await ai.chat({
        system: `You are a dropshipping business analyst. Provide concise, actionable insights (max 200 words, 3-5 bullet points).`,
        prompt: `Analyze this dropshipping store report and give actionable recommendations:

Period: ${report.period}
Total Orders: ${report.summary.totalOrders}
Net Revenue: $${report.summary.netRevenue}
Avg Order Value: $${report.summary.avgOrderValue}
Fulfillment Rate: ${report.summary.fulfillmentRate}
Total Refunds: $${report.summary.totalRefunds}
Top Product: ${report.topProducts[0]?.title || 'N/A'} ($${report.topProducts[0]?.revenue?.toFixed(2) || 0})

Provide 3-5 bullet point insights and recommendations to improve profitability.`,
        maxTokens: 400
      });
    } catch (err) {
      logger.error('AI insights generation failed', { error: err.message });
      return 'Could not generate AI insights at this time.';
    }
  }
}

module.exports = new Analytics();
