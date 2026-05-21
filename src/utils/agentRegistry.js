/**
 * agentRegistry.js — Shared Agent Status Store (CJS)
 * Lightweight in-memory singleton — each agent calls agentRegistry.update()
 * and the /api/agents/status endpoint reads from it.
 */

const AGENTS = ['research', 'listing', 'pricing', 'fulfillment', 'inventory', 'support'];

const defaultState = () => ({
  status: 'idle',      // 'idle' | 'running' | 'error'
  lastRun: null,       // ISO timestamp of last completed run
  lastError: null,
  lastStats: {},
  startedAt: new Date().toISOString(),
});

class AgentRegistry {
  constructor() {
    this._store = new Map();
    AGENTS.forEach(name => this._store.set(name, defaultState()));
  }

  /** Merge patch into an agent's state */
  update(agentName, patch) {
    const current = this._store.get(agentName) || defaultState();
    this._store.set(agentName, {
      ...current,
      ...patch,
      lastError: patch.status === 'error'
        ? (patch.lastError || current.lastError)
        : null,
    });
  }

  get(agentName) {
    return this._store.get(agentName) || defaultState();
  }

  getAll() {
    const result = {};
    for (const [name, state] of this._store.entries()) {
      result[name] = { ...state, name };
    }
    return result;
  }

  isAnyRunning() {
    for (const state of this._store.values()) {
      if (state.status === 'running') return true;
    }
    return false;
  }

  getErrored() {
    return [...this._store.entries()]
      .filter(([, s]) => s.status === 'error')
      .map(([name, s]) => ({ name, ...s }));
  }
}

module.exports = new AgentRegistry();
