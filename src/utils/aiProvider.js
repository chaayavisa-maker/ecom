/**
 * Universal AI Provider
 * Supports: claude (Anthropic) | grok (xAI)
 * Controlled by AI_PROVIDER env var
 *
 * Both providers share an identical call interface:
 *   aiProvider.chat({ system, prompt, maxTokens }) → string
 *   aiProvider.chatJSON({ system, prompt, maxTokens }) → parsed object
 */

const logger = require('./logger');

// ─── Provider implementations ────────────────────────────────────────────────

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
      messages: [{ role: 'user', content: prompt }]
    });
    return response.content[0].text;
  }
}

class GrokProvider {
   constructor() {
    if (!process.env.GROK_API_KEY) {
      throw new Error('GROQ_API_KEY is not set in .env');
    }
    this.apiKey = process.env.GROK_API_KEY;
    this.model = process.env.GROK_MODEL || 'llama-3.3-70b-versatile';
    this.baseURL = 'https://api.groq.com/openai/v1';
    this.name = 'Groq (LLaMA)';
  }

  async chat({ system, prompt, maxTokens = 1000 }) {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`${response.status} "${error?.error?.message || response.statusText}"`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}

// ─── Shared wrapper with JSON parsing + retry logic ──────────────────────────

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

  /**
   * Send a chat message and return raw text
   */
  async chat({ system, prompt, maxTokens = 1000 }) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const text = await this.provider.chat({ system, prompt, maxTokens });
        return text.trim();
      } catch (error) {
        lastError = error;
        const isRateLimit = error.status === 429 || error.message?.includes('rate');
        const delay = isRateLimit ? 10000 * attempt : 2000 * attempt;

        logger.warn(`AI call failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
        if (attempt < maxRetries) await this._sleep(delay);
      }
    }

    throw new Error(`AI provider failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Send a chat message expecting a JSON response, with automatic parsing + cleanup
   */
  async chatJSON({ system, prompt, maxTokens = 1000 }) {
    const systemWithJSON = `${system}\n\nCRITICAL: Respond ONLY with valid JSON. No markdown code blocks, no backticks, no preamble, no explanation. Raw JSON only.`;

    const text = await this.chat({ system: systemWithJSON, prompt, maxTokens });
    return this._parseJSON(text);
  }

  /**
   * Robust JSON parser — strips markdown fences and trailing text
   */
  _parseJSON(text) {
    // Strip ```json ... ``` or ``` ... ``` fences
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Try direct parse first
    try {
      return JSON.parse(clean);
    } catch (_) {}

    // Extract first JSON object or array
    const objMatch = clean.match(/(\{[\s\S]*\})/);
    const arrMatch = clean.match(/(\[[\s\S]*\])/);

    const candidate = arrMatch?.[1] || objMatch?.[1];
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch (_) {}
    }

    throw new Error(`Could not parse JSON from AI response: ${clean.substring(0, 200)}`);
  }

  get providerName() {
    return this.provider.name;
  }

  get modelName() {
    return this.provider.model;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton — all agents share one provider instance
module.exports = new AIProvider();
