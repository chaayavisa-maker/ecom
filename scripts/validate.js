#!/usr/bin/env node
/**
 * Connection Validator
 * Checks all credentials and API connections before launch.
 * Usage: npm run validate
 */
require('dotenv').config();

async function validate() {
  console.log('\n🔍  Dropship AI — Connection Validator');
  console.log('═'.repeat(44));

  let allOk  = true;
  let warns  = 0;

  const ok   = (msg) => console.log(`  ✅  ${msg}`);
  const fail = (msg) => { console.log(`  ❌  ${msg}`); allOk = false; };
  const warn = (msg) => { console.log(`  ⚠️   ${msg}`); warns++; };
  const head = (msg) => console.log(`\n${msg}`);

  // ── Shopify ───────────────────────────────────────────
  head('🛒  Shopify');
  const shopName = process.env.SHOPIFY_SHOP_NAME;
  const token    = process.env.SHOPIFY_ACCESS_TOKEN;
  const clientId = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;

  if (!shopName || shopName === 'your-store.myshopify.com') {
    fail('SHOPIFY_SHOP_NAME not set');
  } else {
    ok(`SHOPIFY_SHOP_NAME = ${shopName}`);
  }

  if (!token) {
    fail('SHOPIFY_ACCESS_TOKEN not set — run: npm run auth');
    allOk = false;
  } else {
    ok(`SHOPIFY_ACCESS_TOKEN = ${token.substring(0, 10)}***`);

    // Test live connection
    try {
      const { getShopifyClient } = require('../src/shopify/client');
      const shopify = getShopifyClient();
      const shop    = await shopify.shop.get();
      ok(`Connected: "${shop.name}" — Plan: ${shop.plan_display_name} — Currency: ${shop.currency}`);
    } catch (err) {
      fail(`Shopify connection failed: ${err.message}`);
    }
  }

  if (!clientId) {
    warn('SHOPIFY_CLIENT_ID not set (only needed to re-run auth)');
  } else {
    ok(`SHOPIFY_CLIENT_ID = ${clientId.substring(0, 8)}***`);
  }

  // ── AI Provider ───────────────────────────────────────
  const provider = (process.env.AI_PROVIDER || 'claude').toLowerCase();
  head(`🤖  AI Provider: ${provider}`);

  if (provider === 'grok' || provider === 'xai') {
    const key = process.env.GROK_API_KEY;
    if (!key || key === 'xai-your_key_here') {
      fail('GROK_API_KEY not set — get one free at https://console.x.ai');
    } else {
      ok(`GROK_API_KEY = ${key.substring(0, 10)}***  (model: ${process.env.GROK_MODEL || 'grok-3'})`);
      try {
        const ai = require('../src/utils/aiProvider');
        const r  = await ai.chat({ system: 'Reply with the single word: OK', prompt: 'OK', maxTokens: 5 });
        ok(`Grok responded: "${r.trim()}"`);
      } catch (err) {
        fail(`Grok API test failed: ${err.message}`);
      }
    }
  } else {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === 'sk-ant-your_key_here') {
      fail('ANTHROPIC_API_KEY not set — get one at https://console.anthropic.com');
    } else {
      ok(`ANTHROPIC_API_KEY = ${key.substring(0, 12)}***  (model: ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514'})`);
      try {
        const ai = require('../src/utils/aiProvider');
        const r  = await ai.chat({ system: 'Reply with the single word: OK', prompt: 'OK', maxTokens: 5 });
        ok(`Claude responded: "${r.trim()}"`);
      } catch (err) {
        fail(`Claude API test failed: ${err.message}`);
      }
    }
  }

  // ── Suppliers ─────────────────────────────────────────
  head('📦  Suppliers (optional)');
  if (process.env.ALIEXPRESS_APP_KEY) ok('AliExpress App Key set');
  else warn('ALIEXPRESS_APP_KEY not set — product research will use CJ only');

  if (process.env.CJ_API_KEY) ok('CJ Dropshipping API Key set');
  else warn('CJ_API_KEY not set — auto-ordering unavailable');

  // ── Server config ─────────────────────────────────────
  head('⚙️   Server');
  ok(`PORT = ${process.env.PORT || 3000}`);
  ok(`NODE_ENV = ${process.env.NODE_ENV || 'development'}`);
  if (process.env.BASE_URL) ok(`BASE_URL = ${process.env.BASE_URL}`);
  else warn('BASE_URL not set — Shopify webhooks won\'t auto-register');
  if (process.env.SHOPIFY_WEBHOOK_SECRET) ok('Webhook secret set');
  else warn('SHOPIFY_WEBHOOK_SECRET not set — webhooks won\'t be verified');

  // ── Pricing ───────────────────────────────────────────
  head('💰  Pricing');
  ok(`Markup: ${process.env.DEFAULT_MARKUP_PERCENT || 200}%`);
  ok(`Min margin: ${process.env.MIN_PROFIT_MARGIN || 30}%`);
  ok(`Shipping buffer: $${process.env.SHIPPING_BUFFER || 5}`);
  ok(`Auto-fulfill: ${process.env.AUTO_FULFILL_ORDERS || 'true'}`);
  ok(`Auto-publish: ${process.env.AUTO_PUBLISH_PRODUCTS || 'false'}`);

  // ── Result ────────────────────────────────────────────
  console.log('\n' + '─'.repeat(44));
  if (allOk && warns === 0) {
    console.log('✅  All checks passed! Run: npm start\n');
    process.exit(0);
  } else if (allOk) {
    console.log(`✅  Ready to launch (${warns} warning${warns > 1 ? 's' : ''} — see above)`);
    console.log('   Run: npm start\n');
    process.exit(0);
  } else {
    console.log('❌  Fix the errors above, then run: npm run validate\n');
    process.exit(1);
  }
}

validate().catch(err => {
  console.error('\n❌  Validator crashed:', err.message, '\n');
  process.exit(1);
});
