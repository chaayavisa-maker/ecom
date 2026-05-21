/**
 * agentRegistry.js — Shared Agent Status Store
 *
 * A lightweight in-memory registry that each agent updates with its
 * current status, last run time, and stats. The /api/agents/status
 * endpoint in server.js reads from this.
 *
 * No external dependencies — just a module-level singleton Map.
 */

const AGENTS = ['research', 'listing', 'pricing', 'fulfillment', 'inventory', 'support'];

const DEFAULT_STATE = () => ({
  status: 'idle',       // 'idle' | 'running' | 'error'
  lastRun: null,        // ISO timestamp
  lastError: null,
  lastStats: {},
  startedAt: new Date().toISOString(),
});

class AgentRegistry {
  constructor() {
    this._store = new Map();
    AGENTS.forEach(name => this._store.set(name, DEFAULT_STATE()));
  }

  /**
   * Update an agent's state. Merges with existing state.
   * @param {string} agentName
   * @param {object} patch
   */
  update(agentName, patch) {
    const current = this._store.get(agentName) ?? DEFAULT_STATE();
    this._store.set(agentName, {
      ...current,
      ...patch,
      // Clear lastError when status returns to idle/running
      lastError: patch.status === 'error' ? (patch.lastError ?? current.lastError) : null,
    });
  }

  /**
   * Get state for a single agent.
   * @param {string} agentName
   * @returns {object}
   */
  get(agentName) {
    return this._store.get(agentName) ?? DEFAULT_STATE();
  }

  /**
   * Get state for all agents.
   * @returns {object}  { research: {...}, listing: {...}, ... }
   */
  getAll() {
    const result = {};
    for (const [name, state] of this._store.entries()) {
      result[name] = { ...state, name };
    }
    return result;
  }

  /**
   * Returns true if any agent is currently running.
   */
  isAnyRunning() {
    for (const state of this._store.values()) {
      if (state.status === 'running') return true;
    }
    return false;
  }

  /**
   * Returns list of agents currently in error state.
   */
  getErrored() {
    return [...this._store.entries()]
      .filter(([, state]) => state.status === 'error')
      .map(([name, state]) => ({ name, ...state }));
  }
}

// Singleton
export const agentRegistry = new AgentRegistry();
