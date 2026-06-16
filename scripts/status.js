#!/usr/bin/env node
'use strict';

/**
 * scripts/status.js — Headless Status Report
 *
 * Run with:  npm run status
 *
 * Shows:
 *  - Active niches + expiry
 *  - Pending niche suggestions (if any)
 *  - Recent log entries (last 30 lines)
 *  - Shopify: product count, recent orders (live API call)
 *  - Environment health checks
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
};

function c(color, text) { return `${C[color]}${text}${C.reset}`; }

function section(title) {
  console.log(`\n${c('bold', `── ${title} ${'─'.repeat(Math.max(0, 38 - title.length))}`)}`);
}

function ok(label, value) {
  console.log(`  ${c('green', '✓')} ${label.padEnd(28)} ${c('dim', value || '')}`);
}

function warn(label, value) {
  console.log(`  ${c('yellow', '!')} ${label.padEnd(28)} ${c('yellow', value || '')}`);
}

function fail(label, value) {
  console.log(`  ${c('red', '✗')} ${label.padEnd(28)} ${c('red', value || '')}`);
}

// ─── Environment checks ───────────────────────────────────────────────────────

function checkEnv() {
  section('Environment');

  const checks = [
    { key: 'SHOPIFY_SHOP_NAME',    label: 'Shopify shop',    required: true  },
    { key: 'SHOPIFY_ACCESS_TOKEN', label: 'Shopify token',   required: true  },
    { key: 'CJ_API_KEY',           label: 'CJ Dropshipping', required: false },
    { key: 'ALIEXPRESS_APP_KEY',   label: 'AliExpress key',  required: false },
    { key: 'GROK_API_KEY',         label: 'Groq API key',    required: false },
    { key: 'ANTHROPIC_API_KEY',    label: 'Anthropic key',   required: false },
  ];

  for (const { key, label, required } of checks) {
    const value = process.env[key];
    if (value && value.length > 4) {
      ok(label, `${value.slice(0, 6)}…`);
    } else if (required) {
      fail(label, 'NOT SET');
    } else {
      warn(label, 'not set (optional)');
    }
  }

  const provider = process.env.AI_PROVIDER || 'claude';
  const model    = process.env.GROK_MODEL || process.env.CLAUDE_MODEL || '?';
  ok('AI provider', `${provider} (${model})`);

  const autoPublish = process.env.AUTO_PUBLISH_PRODUCTS;
  if (autoPublish === 'true') {
    ok('Auto publish', 'enabled — products go live immediately');
  } else {
    warn('Auto publish', 'disabled — products stay as draft');
  }

  const autoFulfill = process.env.AUTO_FULFILL_ORDERS;
  if (autoFulfill === 'true') {
    ok('Auto fulfillment', 'enabled');
  } else {
    warn('Auto fulfillment', 'disabled');
  }

  const markup = process.env.DEFAULT_MARKUP_PERCENT || '200';
  ok('Default markup', `${markup}%`);
}

// ─── Niche status ─────────────────────────────────────────────────────────────

function checkNiches() {
  section('Niches');

  let nicheConfig;
  try {
    nicheConfig = require('../src/config/niches');
  } catch {
    fail('Niche config module', 'not found');
    return;
  }

  const approved = nicheConfig.getApprovedNiches();
  const pending  = nicheConfig.getPendingNiches();
  const expired  = nicheConfig.getExpiredNiches();

  if (approved.length > 0) {
    ok(`Active niches (${approved.length})`, approved.join(', '));
    console.log(c('dim', `    Expire after ${nicheConfig.EXPIRY_DAYS} days from approval`));
  } else {
    warn('Active niches', 'none — using built-in defaults');
  }

  if (pending.length > 0) {
    warn(`Pending approval (${pending.length})`, `run \`npm run niches\` to review`);
    pending.forEach(n => console.log(`    ${c('yellow', '→')} ${n.name}`));
  }

  if (expired.length > 0) {
    warn(`Expired (${expired.length})`, expired.join(', '));
  }
}

// ─── Recent logs ──────────────────────────────────────────────────────────────

function showRecentLogs(lines = 30) {
  section('Recent Activity (last 30 log entries)');

  const logPath = path.join(process.cwd(), 'logs', 'combined.log');
  if (!fs.existsSync(logPath)) {
    console.log(c('dim', '  No log file found yet.'));
    return;
  }

  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.split('\n').filter(Boolean);
    const recent   = allLines.slice(-lines);

    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        const time  = new Date(entry.timestamp).toLocaleTimeString();
        const level = entry.level || 'info';
        const msg   = entry.message || '';

        let color = 'dim';
        if (level === 'error') color = 'red';
        else if (level === 'warn') color = 'yellow';
        else if (msg.includes('✅') || msg.includes('complete') || msg.includes('created')) color = 'green';

        console.log(`  ${c('dim', time)} ${c(color, msg.slice(0, 110))}`);
      } catch {
        // Non-JSON log line
        console.log(c('dim', `  ${line.slice(0, 120)}`));
      }
    }
  } catch (err) {
    fail('Log read error', err.message);
  }
}

// ─── Shopify live stats ───────────────────────────────────────────────────────

async function checkShopify() {
  section('Shopify (live)');

  if (!process.env.SHOPIFY_SHOP_NAME || !process.env.SHOPIFY_ACCESS_TOKEN) {
    fail('Shopify credentials', 'missing — skipping live check');
    return;
  }

  try {
    const Shopify = require('shopify-api-node');
    const shopify = new Shopify({
      shopName:    process.env.SHOPIFY_SHOP_NAME.replace('.myshopify.com', ''),
      accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    });

    // Products
    const [activeCount, draftCount] = await Promise.all([
      shopify.product.count({ status: 'active'  }).catch(() => '?'),
      shopify.product.count({ status: 'draft'   }).catch(() => '?'),
    ]);
    ok('Active products',  String(activeCount));
    if (draftCount > 0) warn('Draft products', `${draftCount} not yet published`);
    else ok('Draft products', String(draftCount));

    // Recent orders (last 7 days)
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const orders = await shopify.order.list({ created_at_min: since, status: 'any', limit: 250 }).catch(() => []);

    const revenue   = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const fulfilled = orders.filter(o => o.fulfillment_status === 'fulfilled').length;

    ok('Orders (last 7d)',     `${orders.length} orders`);
    ok('Revenue (last 7d)',    `$${revenue.toFixed(2)}`);
    ok('Fulfillment rate',     orders.length > 0 ? `${Math.round(fulfilled / orders.length * 100)}%` : 'N/A');

    if (orders.length === 0) {
      console.log(c('dim', '  Tip: make sure products are published (active) and store is live'));
    }

  } catch (err) {
    fail('Shopify API error', err.message.slice(0, 80));
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

async function main() {
  const now = new Date().toLocaleString();
  console.log(`\n${c('bold', '══════════════════════════════════════════')}`);
  console.log(c('bold', '   🤖  Dropship AI — Status Report'));
  console.log(c('dim',  `   ${now}`));
  console.log(c('bold', '══════════════════════════════════════════'));

  checkEnv();
  checkNiches();
  await checkShopify();
  showRecentLogs();

  console.log(`\n${c('dim', '── Tips ─────────────────────────────────')}`);
  console.log(c('dim', '  npm run niches    → approve AI niche suggestions'));
  console.log(c('dim', '  npm run status    → this report'));
  console.log(c('dim', '  npm run validate  → full API connection test'));
  console.log('');
}

main().catch(err => {
  console.error(c('red', `\n❌ ${err.message}`));
  process.exit(1);
});
