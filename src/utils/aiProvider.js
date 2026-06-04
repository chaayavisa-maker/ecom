/**
 * Universal AI Provider
 * Supports: claude (Anthropic) | grok (xAI / Groq)
 * Controlled by AI_PROVIDER env var
 *
 * Both providers share an identical call interface:
 *   aiProvider.chat({ system, prompt, maxTokens }) → string
 *   aiProvider.chatJSON({ system, prompt, maxTokens }) → parsed object
 */

const logger = require('./logger');

// ─── Provider implementations ─────────────────────────────────────────────────

class ClaudeProvider {
  constructor() {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in .env');
    }
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
    this.name = 'Claude (Anthropic)';
  }

  async chat({ system, prompt, maxTokens = 1000 }) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text;
  }
}

class GrokProvider {
  constructor() {
    if (!process.env.GROK_API_KEY) {
      throw new Error('GROK_API_KEY is not set in .env');
    }
    this.apiKey  = process.env.GROK_API_KEY;
    this.model   = process.env.GROK_MODEL || 'llama-3.3-70b-versatile';
    this.baseURL = 'https://api.groq.com/openai/v1';
    this.name    = 'Groq (LLaMA)';
  }

  /**
   * @param {object}  opts
   * @param {boolean} opts.jsonMode  — when true, sets response_format + wraps array prompts
   */
  async chat({ system, prompt, maxTokens = 1000, jsonMode = false }) {
    const body = {
      model:      this.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
    };

    // ── FIX 1: use Groq's JSON mode to guarantee parseable output ─────────────
    // response_format only works with objects, not bare arrays.
    // When the prompt asks for an array we wrap it in {"result":[...]} and
    // unwrap after parsing (handled in AIProvider.chatJSON).
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`${response.status} "${error?.error?.message || response.statusText}"`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}

// ─── Shared wrapper with JSON parsing + retry logic ───────────────────────────

class AIProvider {
  constructor() {
    this.provider = this._initProvider();
    logger.info(`🤖 AI Provider: ${this.provider.name} (model: ${this.provider.model})`);
  }

  _initProvider() {
    const choice = (process.env.AI_PROVIDER || 'claude').toLowerCase().trim();
    switch (choice) {
      case 'claude':
      case 'anthropic':
        return new ClaudeProvider();
      case 'grok':
      case 'xai':
        return new GrokProvider();
      default:
        logger.warn(`Unknown AI_PROVIDER="${choice}". Falling back to claude.`);
        return new ClaudeProvider();
    }
  }

  /** Send a chat message and return raw text */
  async chat({ system, prompt, maxTokens = 1000 }) {
    return this._callWithRetry({ system, prompt, maxTokens, jsonMode: false });
  }

  /**
   * Send a chat message expecting a JSON response.
   *
   * Fixes vs old version:
   *  - FIX 1: minimum 2000 tokens so scoring 20 products never gets truncated
   *  - FIX 2: passes jsonMode=true → Groq JSON mode active
   *  - FIX 3: wraps array-returning prompts so json_object mode works
   *  - FIX 4: smarter parser with truncation recovery
   */
  async chatJSON({ system, prompt, maxTokens = 1000 }) {
    // ── FIX 1: never let the caller under-budget a JSON response ─────────────
    const safeTokens = Math.max(maxTokens, 2000);

    const systemWithJSON = [
      system,
      'CRITICAL: Respond ONLY with valid JSON.',
      'No markdown code blocks, no backticks, no preamble, no explanation. Raw JSON only.',
      'If the result is an array, wrap it: {"result": [ ... ]}',
    ].join('\n');

    // ── FIX 2/3: enable JSON mode; array wrapper keeps response_format happy ──
    const text = await this._callWithRetry({
      system:    systemWithJSON,
      prompt,
      maxTokens: safeTokens,
      jsonMode:  true,
    });

    return this._parseJSON(text);
  }

  async _callWithRetry({ system, prompt, maxTokens, jsonMode }) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const text = await this.provider.chat({ system, prompt, maxTokens, jsonMode });
        return text.trim();
      } catch (error) {
        lastError = error;
        const isRateLimit = error.status === 429 || error.message?.includes('rate');
        const delay = isRateLimit ? 10_000 * attempt : 2_000 * attempt;
        logger.warn(`AI call failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
        if (attempt < maxRetries) await this._sleep(delay);
      }
    }

    throw new Error(`AI provider failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Robust JSON parser — handles:
   *  - {"result":[...]} wrapper (from our array workaround)
   *  - markdown fences
   *  - leading/trailing prose
   *  - truncated arrays (attempts repair)
   *
   * ── FIX 4 ──
   */
  _parseJSON(text) {
    // Strip markdown fences
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Direct parse
    try {
      const parsed = JSON.parse(clean);
      // Unwrap {"result":[...]} if present
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.result)) {
        return parsed.result;
      }
      return parsed;
    } catch (_) {}

    // Extract the outermost array or object — prefer array, then object
    const arrMatch = clean.match(/(\[[\s\S]*\])/);
    const objMatch = clean.match(/(\{[\s\S]*\})/);

    for (const candidate of [arrMatch?.[1], objMatch?.[1]]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.result)) {
          return parsed.result;
        }
        return parsed;
      } catch (_) {}
    }

    // Last resort: attempt to repair a truncated array by closing it
    const partialArr = clean.match(/(\[[\s\S]*)/);
    if (partialArr) {
      // Remove any incomplete trailing object then close the array
      const truncated = partialArr[1].replace(/,?\s*\{[^}]*$/, ']');
      try {
        const parsed = JSON.parse(truncated);
        if (Array.isArray(parsed) && parsed.length > 0) {
          logger.warn('[AI] Repaired truncated JSON array — consider raising maxTokens');
          return parsed;
        }
      } catch (_) {}
    }

    throw new Error(`Could not parse JSON from AI response: ${clean.substring(0, 200)}`);
  }

  get providerName() { return this.provider.name;  }
  get modelName()    { return this.provider.model; }
  _sleep(ms)         { return new Promise(r => setTimeout(r, ms)); }
}

// Singleton — all agents share one provider instance
module.exports = new AIProvider();
