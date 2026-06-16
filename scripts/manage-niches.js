#!/usr/bin/env node
'use strict';

/**
 * scripts/manage-niches.js — Niche Approval CLI
 *
 * Run with:  npm run niches
 *
 * Shows pending AI-suggested niches and lets you approve or reject each one
 * interactively. Approved niches are immediately used by the research agent.
 */

require('dotenv').config();

const readline = require('readline');
const nicheConfig = require('../src/config/niches');

// ─── Colours (no deps) ────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function printHeader() {
  console.log('\n' + c('bold', '══════════════════════════════════════'));
  console.log(c('bold', '   🎯  Niche Approval Manager'));
  console.log(c('bold', '══════════════════════════════════════'));
}

function printApprovedSummary() {
  const approved = nicheConfig.getApprovedNiches();
  const expired  = nicheConfig.getExpiredNiches();

  if (approved.length > 0) {
    console.log(`\n${c('green', '✅ Currently active niches:')} (valid for ${nicheConfig.EXPIRY_DAYS} days)`);
    approved.forEach(n => console.log(`   ${c('green', '•')} ${n}`));
  }
  if (expired.length > 0) {
    console.log(`\n${c('yellow', '⏰ Expired niches')} (will be replaced by new AI suggestions):`);
    expired.forEach(n => console.log(`   ${c('dim', '•')} ${n}`));
  }
  if (approved.length === 0 && expired.length === 0) {
    console.log(`\n${c('dim', 'No approved niches yet.')}`);
  }
}

// ─── Main flow ────────────────────────────────────────────────────────────────

async function main() {
  printHeader();

  const config  = nicheConfig.load();
  const pending = nicheConfig.getPendingNiches();

  printApprovedSummary();

  // ── Show all niches in the config ──────────────────────────────────────────
  const rejected = config.niches.filter(n => n.status === 'rejected');
  if (rejected.length > 0) {
    console.log(`\n${c('dim', 'Previously rejected:')} ${rejected.map(n => n.name).join(', ')}`);
  }

  if (pending.length === 0) {
    console.log(`\n${c('yellow', '💡 No pending suggestions right now.')}`);
    console.log(c('dim', '   The research agent will generate new ones on its next run,'));
    console.log(c('dim', '   or you can add niches manually (see below).'));
    await showManualAddMenu();
    return;
  }

  // ── Review pending niches ──────────────────────────────────────────────────
  console.log(`\n${c('cyan', `📋 ${pending.length} AI suggestion(s) waiting for your review:`)}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const approved = [];
  const rejectedNow = [];

  for (let i = 0; i < pending.length; i++) {
    const niche = pending[i];
    const num   = `[${i + 1}/${pending.length}]`;
    console.log(`${c('bold', num)} ${c('cyan', niche.name)}`);
    console.log(c('dim', `     Suggested: ${new Date(niche.suggestedAt).toLocaleDateString()}`));

    const answer = await prompt(
      rl,
      `     ${c('green', 'a')}pprove / ${c('red', 'r')}eject / ${c('yellow', 's')}kip  [a/r/s]: `
    );

    const choice = answer.trim().toLowerCase();
    if (choice === 'a' || choice === 'approve') {
      approved.push(niche.name);
      console.log(c('green', '     ✅ Approved\n'));
    } else if (choice === 'r' || choice === 'reject') {
      rejectedNow.push(niche.name);
      console.log(c('red', '     ❌ Rejected\n'));
    } else {
      console.log(c('dim', '     ⏭  Skipped\n'));
    }
  }

  rl.close();

  if (approved.length === 0 && rejectedNow.length === 0) {
    console.log(c('dim', '\nNothing changed.'));
    return;
  }

  nicheConfig.applyApprovals(approved, rejectedNow);

  console.log('\n' + c('bold', '── Summary ──────────────────────────────'));
  if (approved.length > 0) {
    console.log(c('green', `✅ Approved (${approved.length}):`));
    approved.forEach(n => console.log(`   • ${n}`));
  }
  if (rejectedNow.length > 0) {
    console.log(c('red', `❌ Rejected (${rejectedNow.length}):`));
    rejectedNow.forEach(n => console.log(`   • ${n}`));
  }

  const totalApproved = nicheConfig.getApprovedNiches().length;
  console.log(`\n${c('green', `🎯 ${totalApproved} active niche(s) ready for next research run.`)}`);

  if (totalApproved === 0) {
    console.log(c('yellow', '\n⚠️  No approved niches — the agent will use built-in defaults until you approve some.'));
  }
}

async function showManualAddMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt(rl, `\nWant to add a niche manually? Type it (or press Enter to skip): `);
  rl.close();

  const name = answer.trim();
  if (!name) return;

  nicheConfig.savePendingNiches([name]);
  // Auto-approve manually entered niches
  nicheConfig.setNicheStatus(name, 'approved');
  console.log(c('green', `✅ "${name}" added and approved.`));
}

main().catch(err => {
  console.error(c('red', `\n❌ Error: ${err.message}`));
  process.exit(1);
});
