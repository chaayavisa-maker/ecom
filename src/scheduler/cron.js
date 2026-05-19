require('dotenv').config();
const cron = require('node-cron');
const logger = require('../utils/logger');

const productResearchAgent = require('../agents/productResearchAgent');
const listingAgent         = require('../agents/listingAgent');
const pricingAgent         = require('../agents/pricingAgent');
const fulfillmentAgent     = require('../agents/fulfillmentAgent');
const inventoryAgent       = require('../agents/inventoryAgent');
const supportAgent         = require('../agents/supportAgent');

const runningJobs = new Set();

async function runJob(name, agentOrFn) {
  if (runningJobs.has(name)) {
    logger.warn(`⏩ Skipping ${name} — previous run still active`);
    return;
  }
  runningJobs.add(name);
  const start = Date.now();
  logger.info(`🟢 Starting job: ${name}`);
  try {
    typeof agentOrFn === 'function' ? await agentOrFn() : await agentOrFn.run();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`✅ Job complete: ${name} (${elapsed}s)`);
  } catch (error) {
    logger.error(`❌ Job failed: ${name}`, { error: error.message });
  } finally {
    runningJobs.delete(name);
  }
}

function startScheduler() {
  logger.info('🗓️  Dropship AI Scheduler starting...');

  // Product Research + Listing — every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    if (runningJobs.has('research')) return;
    runningJobs.add('research');
    logger.info('🔍 Product Research + Listing cycle starting...');
    try {
      const products = await productResearchAgent.run();
      if (products.length > 0) {
        logger.info(`📝 Listing ${products.length} winning products...`);
        await listingAgent.bulkProcess(products);
      } else {
        logger.info('No new winning products found this cycle');
      }
    } catch (e) {
      logger.error('Research+Listing cycle failed', { error: e.message });
    } finally {
      runningJobs.delete('research');
    }
  });

  // Fulfillment Agent — every 15 minutes
  cron.schedule('*/15 * * * *', () => runJob('fulfillment', fulfillmentAgent));

  // Pricing Agent — every hour
  cron.schedule('0 * * * *', () => runJob('pricing', pricingAgent));

  // Inventory Agent — every 30 minutes
  cron.schedule('*/30 * * * *', () => runJob('inventory', inventoryAgent));

  // Customer Support Agent — every hour at :30
  cron.schedule('30 * * * *', () => runJob('support', supportAgent));

  // Tracking Updates — every 2 hours
  cron.schedule('0 */2 * * *', () =>
    runJob('tracking', () => fulfillmentAgent.updateTracking())
  );

  // Daily Analytics + Health Check — every day at 8am
  cron.schedule('0 8 * * *', () =>
    runJob('daily-report', async () => {
      logger.info('📊 === DAILY HEALTH CHECK & ANALYTICS ===');
      const analytics = require('../utils/analytics');
      const shopifyOrders = require('../shopify/orders');

      const [stats, report] = await Promise.all([
        shopifyOrders.getRevenueStats(30),
        analytics.getProfitReport(30)
      ]);

      logger.info(`💰 Last 30 days: $${stats.totalRevenue} revenue | ${stats.totalOrders} orders | $${stats.avgOrderValue} AOV`);
      logger.info(`📦 Fulfillment rate: ${report?.summary?.fulfillmentRate || 'N/A'}`);

      if (report) {
        const insights = await analytics.getAIInsights(report);
        logger.info(`🤖 AI Insights:\n${insights}`);
      }
    })
  );

  logger.info('✅ All cron jobs scheduled:');
  logger.info('   📦 Fulfillment:       every 15 minutes');
  logger.info('   💰 Pricing:           every hour');
  logger.info('   🏷️  Inventory:         every 30 minutes');
  logger.info('   💬 Support:           every hour (:30)');
  logger.info('   🔍 Research + List:   every 6 hours');
  logger.info('   🚚 Tracking Updates:  every 2 hours');
  logger.info('   📊 Daily Report:      8:00 AM daily');

  // Staggered startup runs
  setTimeout(() => runJob('fulfillment', fulfillmentAgent), 5000);
  setTimeout(() => runJob('inventory', inventoryAgent),     15000);
  setTimeout(() => runJob('pricing', pricingAgent),         30000);
  setTimeout(() => runJob('support', supportAgent),         60000);
}

if (require.main === module) {
  require('dotenv').config();
  startScheduler();
  logger.info('🤖 Scheduler running. Press Ctrl+C to stop.');
}

module.exports = { startScheduler };
