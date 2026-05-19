#!/usr/bin/env node
/**
 * run-agent.js — GitHub Actions entrypoint
 * Usage: node scripts/run-agent.js <agentName>
 * Agents: fulfillment | inventory | pricing | support | research | tracking | daily-report
 */
require('dotenv').config();
const logger = require('../src/utils/logger');

const AGENT = process.argv[2];
if (!AGENT) {
  logger.error('Usage: node scripts/run-agent.js <agentName>');
  process.exit(1);
}

async function main() {
  logger.info(`🚀 GitHub Actions runner — agent: ${AGENT}`);
  const start = Date.now();

  try {
    switch (AGENT) {
      case 'fulfillment': {
        const agent = require('../src/agents/fulfillmentAgent');
        await agent.run();
        break;
      }
      case 'tracking': {
        const agent = require('../src/agents/fulfillmentAgent');
        await agent.updateTracking();
        break;
      }
      case 'inventory': {
        const agent = require('../src/agents/inventoryAgent');
        await agent.run();
        break;
      }
      case 'pricing': {
        const agent = require('../src/agents/pricingAgent');
        await agent.run();
        break;
      }
      case 'support': {
        const agent = require('../src/agents/supportAgent');
        await agent.run();
        break;
      }
      case 'research': {
        const researchAgent = require('../src/agents/productResearchAgent');
        const listingAgent  = require('../src/agents/listingAgent');
        const products = await researchAgent.run();
        if (products && products.length > 0) {
          logger.info(`📝 Listing ${products.length} winning products...`);
          await listingAgent.bulkProcess(products);
        } else {
          logger.info('No new winning products found this cycle.');
        }
        break;
      }
      case 'daily-report': {
        const analytics    = require('../src/utils/analytics');
        const shopifyOrders = require('../src/shopify/orders');
        logger.info('📊 === DAILY HEALTH CHECK & ANALYTICS ===');
        const [stats, report] = await Promise.all([
          shopifyOrders.getRevenueStats(30),
          analytics.getProfitReport(30),
        ]);
        logger.info(`💰 Last 30d: $${stats.totalRevenue} revenue | ${stats.totalOrders} orders | $${stats.avgOrderValue} AOV`);
        logger.info(`📦 Fulfillment rate: ${report?.summary?.fulfillmentRate || 'N/A'}`);
        if (report) {
          const insights = await analytics.getAIInsights(report);
          logger.info(`🤖 AI Insights:\n${insights}`);
        }
        break;
      }
      default:
        logger.error(`Unknown agent: "${AGENT}". Valid: fulfillment | tracking | inventory | pricing | support | research | daily-report`);
        process.exit(1);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`✅ Agent "${AGENT}" finished in ${elapsed}s`);
    process.exit(0);
  } catch (err) {
    logger.error(`❌ Agent "${AGENT}" failed: ${err.message}`, { stack: err.stack });
    process.exit(1);
  }
}

main();
