// Claude API proxy for the Sprout project assistant.
//
// When a node runs with ANTHROPIC_API_KEY, browsers send their Messages API
// requests to POST /api/assistant/v1/messages instead of api.anthropic.com,
// so visitors never need their own key and the key never reaches a browser.
// The proxy only forwards Sprout-shaped requests: a fixed model, a capped
// max_tokens, and only the tools Sprout uses.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.FEDROK_ASSISTANT_MODEL || 'claude-opus-5-5';
const MAX_TOKENS = 16000;
const ALLOWED_TOOLS = new Set(['get_project', 'update_project', 'web_fetch']);
const ALLOWED_FETCH_DOMAINS = new Set(['fedrok.com', 'www.fedrok.com']);
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;

export function createAssistantProxy({ log = console } = {}) {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from the environment
  const hits = [];
  log.info?.(`Sprout assistant proxy enabled (${MODEL})`);

  return async function proxy(body) {
    const now = Date.now();
    while (hits.length && now - hits[0] > WINDOW_MS) hits.shift();
    if (hits.length >= MAX_PER_WINDOW) return { code: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'assistant proxy is busy, try again in a minute' } } };
    hits.push(now);
    if (!body || !Array.isArray(body.messages)) return { code: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'messages are required' } } };
    for (const t of body.tools || []) {
      if (!ALLOWED_TOOLS.has(t.name)) return { code: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `tool ${t.name} is not allowed through this proxy` } } };
      if (t.type && t.type.startsWith('web_fetch') && !(t.allowed_domains || []).every((d) => ALLOWED_FETCH_DOMAINS.has(d))) return { code: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'web fetch is limited to fedrok.com' } } };
    }
    const req = {
      model: MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
      system: body.system,
      messages: body.messages,
      tools: body.tools,
      ...(body.output_config ? { output_config: body.output_config } : {}),
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    try {
      const msg = await client.beta.messages.create(req);
      return { code: 200, body: msg };
    } catch (e) {
      if (e instanceof Anthropic.APIError) return { code: e.status || 502, body: e.error || { type: 'error', error: { type: 'api_error', message: e.message } } };
      log.warn?.(`assistant proxy failed: ${e.message}`);
      return { code: 502, body: { type: 'error', error: { type: 'api_error', message: 'could not reach Claude' } } };
    }
  };
}
