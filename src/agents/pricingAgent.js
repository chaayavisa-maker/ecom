/**
 * pricingAgent.js — Improved Pricing Agent (CJS)
 *
 * Improvements:
 *  1. Psychological pricing (X.99 under $50, X.95 over $50)
 *  2. Minimum margin guard — never prices below cost
 *  3. Only updates variants whose price has actually changed (skips no-ops)
 *  4. Live cost refresh from supplier metafield
 *  5. Exports .run() matching run-agent.js expectation
 */

'use strict';

const ai = require('../utils/aiProvider');
const { getShopifyClient } = require('../shopify/client');
const logger = require('../utils/logger');

const DEFAULT_MARKUP   = parseFloat(process.env.DEFAULT_MARKUP_PERCENT || '200') / 100;
const SHIPPING_BUFFER  = parseFloat(process.env.SHIPPING_BUFFER_USD || '5');
const MIN_MARGIN       = parseFloat(process.env.MIN_MARGIN_PERCENT || '20') / 100;
const COMPARE_AT_MULT  = parseFloat(process.env.COMPARE_AT_MULTIPLIER || '1.4');

// ─── Pricing maths ────────────────────────────────────────────────────────────

function psychologicalPrice(raw) {
  const dollars = Math.ceil(raw);
  const ending = dollars < 50 ? 0.99 : 0.95;
  // If raw is already very close to a .99/.95, use that dollar; else next dollar minus ending
  const base = raw >= dollars - ending ? dollars : dollars - 1;
  return (base + ending).toFixed(2);
}

function calculateSellPrice(cost) {
  const base = (cost + SHIPPING_BUFFER) * (1 + DEFAULT_MARKUP);
  const minPrice = cost / (1 - MIN_MARGIN); // enforce minimum margin
  return psychologicalPrice(Math.max(base, minPrice));
}

function calculateCompareAt(sellPrice) {
  return psychologicalPrice(parseFloat(sellPrice) * COMPARE_AT_MULT);
}

// ─── Cost reading ─────────────────────────────────────────────────────────────

async function getStoredCost(shopify, productId) {
  try {
    const metafields = await shopify.metafield.list({
      metafield: { owner_resource: 'product', owner_id: productId },
      namespace: 'custom',
      key: 'supplier_cost',
    });
    const val = metafields[0]?.value;
    return val ? parseFloat(val) : null;
  } catch {
    return null;
  }
}

// ─── Core repricing ───────────────────────────────────────────────────────────

async function repriceProduct(shopify, product) {
  const cost = await getStoredCost(shopify, product.id);
  if (!cost || cost <= 0) return { updated: false, reason: 'no-cost' };

  const newPrice    = calculateSellPrice(cost);
  const compareAt   = calculateCompareAt(newPrice);

  const variantsToUpdate = (product.variants || []).filter(v => {
    return Math.abs(parseFloat(v.price) - parseFloat(newPrice)) > 0.01;
  });

  if (!variantsToUpdate.length) return { updated: false, reason: 'no-change' };

  for (const variant of variantsToUpdate) {
    try {
      await shopify.productVariant.update(variant.id, {
        price: newPrice,
        compare_at_price: compareAt,
      });
      logger.info(`[Pricing] Product ${product.id} variant ${variant.id}: $${variant.price} → $${newPrice}`);
    } catch (err) {
      logger.warn(`[Pricing] Failed to update variant ${variant.id}: ${err.message}`);
    }
    // Respect Shopify REST rate limit (~2 req/s)
    await new Promise(r => setTimeout(r, 600));
  }

  return { updated: true, productId: product.id, newPrice, variantsUpdated: variantsToUpdate.length };
}

// ─── Agent class ──────────────────────────────────────────────────────────────

class PricingAgent {
  constructor() {
    this.name = 'PricingAgent';
  }

  async run() {
    const startTime = Date.now();
    logger.info(`🤖 ${this.name} started [provider: ${ai.providerName}]`);

    const shopify = getShopifyClient();
    let updated = 0, skipped = 0;

    try {
      // Page through all active products
      let page = await shopify.product.list({ status: 'active', limit: 250, fields: 'id,variants' });

      while (true) {
        for (const product of page) {
          const result = await repriceProduct(shopify, product);
          if (result.updated) updated++;
          else skipped++;
        }
        if (!page.nextPageParameters) break;
        page = await shopify.product.list(page.nextPageParameters);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ ${this.name} complete in ${elapsed}s — updated: ${updated}, unchanged: ${skipped}`);
      return { updated, skipped };

    } catch (err) {
      logger.error(`[Pricing] Agent failed: ${err.message}`, { stack: err.stack });
      throw err;
    }
  }
}

module.exports = new PricingAgent();
