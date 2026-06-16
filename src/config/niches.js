'use strict';

/**
 * src/config/niches.js — Niche State Manager
 *
 * Manages the lifecycle of dropshipping niches:
 *   pending  → AI suggested, awaiting your approval  (run: npm run niches)
 *   approved → Active niches the research agent will use
 *   rejected → Discarded, won't be suggested again
 *   expired  → Approved but older than NICHE_EXPIRY_DAYS; AI will suggest fresh ones
 *
 * State is persisted in niche.config.json at the project root.
 * That file is safe to edit by hand too.
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH  = path.join(process.cwd(), 'niche.config.json');
const EXPIRY_DAYS  = parseInt(process.env.NICHE_EXPIRY_DAYS  || '14', 10);
const EXPIRY_MS    = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

// ─── Persistence ──────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { niches: [], meta: { createdAt: new Date().toISOString() } };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { niches: [], meta: {} };
  }
}

function save(data) {
  data.meta = data.meta || {};
  data.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Returns niches that are approved and not yet expired.
 * This is what the research agent actually uses.
 */
function getApprovedNiches() {
  const now = Date.now();
  return load().niches
    .filter(n => {
      if (n.status !== 'approved') return false;
      const age = now - new Date(n.approvedAt).getTime();
      return age < EXPIRY_MS;
    })
    .map(n => n.name);
}

/**
 * Returns all niches with status 'pending' (AI suggested, not yet reviewed).
 */
function getPendingNiches() {
  return load().niches.filter(n => n.status === 'pending');
}

function hasPendingNiches() {
  return load().niches.some(n => n.status === 'pending');
}

function hasApprovedNiches() {
  return getApprovedNiches().length > 0;
}

/**
 * Returns niches that were approved but have since expired.
 * Useful so the agent knows to ask AI for fresh suggestions.
 */
function getExpiredNiches() {
  const now = Date.now();
  return load().niches
    .filter(n => n.status === 'approved' && (now - new Date(n.approvedAt).getTime()) >= EXPIRY_MS)
    .map(n => n.name);
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Saves AI-generated niche suggestions as 'pending'.
 * Skips any niche that already exists (any status) to avoid duplicates.
 * Returns the number of new entries added.
 */
function savePendingNiches(niches) {
  const config = load();
  const existingNames = new Set(config.niches.map(n => n.name.toLowerCase()));

  const newEntries = niches
    .filter(name => name && !existingNames.has(name.toLowerCase()))
    .map(name => ({
      name,
      status:      'pending',
      suggestedAt: new Date().toISOString(),
      approvedAt:  null,
    }));

  config.niches.push(...newEntries);
  save(config);
  return newEntries.length;
}

/**
 * Set a niche's status by name.
 * Used by the manage-niches CLI.
 */
function setNicheStatus(name, status) {
  const config = load();
  const entry = config.niches.find(n => n.name.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`Niche not found: "${name}"`);
  entry.status = status;
  if (status === 'approved') entry.approvedAt = new Date().toISOString();
  save(config);
}

/**
 * Approve a list of niches by name. Rejects the rest (from pending set).
 */
function applyApprovals(approvedNames, rejectedNames) {
  const config = load();
  const approvedSet = new Set(approvedNames.map(n => n.toLowerCase()));
  const rejectedSet = new Set(rejectedNames.map(n => n.toLowerCase()));

  for (const entry of config.niches) {
    if (approvedSet.has(entry.name.toLowerCase())) {
      entry.status     = 'approved';
      entry.approvedAt = new Date().toISOString();
    } else if (rejectedSet.has(entry.name.toLowerCase())) {
      entry.status = 'rejected';
    }
  }

  save(config);
}

/**
 * Returns a set of all rejected niche names (lowercase) for the blacklist.
 */
function getRejectedNames() {
  return load().niches
    .filter(n => n.status === 'rejected')
    .map(n => n.name.toLowerCase());
}

module.exports = {
  load,
  save,
  getApprovedNiches,
  getPendingNiches,
  hasPendingNiches,
  hasApprovedNiches,
  getExpiredNiches,
  savePendingNiches,
  setNicheStatus,
  applyApprovals,
  getRejectedNames,
  CONFIG_PATH,
  EXPIRY_DAYS,
};
