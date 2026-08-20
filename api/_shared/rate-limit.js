/**
 * Spend limits for the AI endpoints.
 *
 * `/api/*` is unauthenticated, and it cannot easily be otherwise: the whole
 * platform is a name-only login, so there is no credential to check. That is
 * fine for ten people in a room and not fine for a URL that has escaped, since
 * one `/api/chat` request drives a dozen model calls and `/api/imagine-result`
 * bills image generation per call.
 *
 * So: bound the cost rather than establish identity. Every AI endpoint declares
 * roughly what it costs, and the counter lives in D1 on the collaboration
 * Worker — a per-instance counter in a serverless function counts only the
 * traffic that reached that instance, and instances multiply exactly when
 * something is hammering them.
 *
 * FAILS OPEN. If the Worker is unreachable the request proceeds. During a
 * workshop, an outage of the collaboration backend must not also take out the
 * assistant; the limiter protects a credit balance, and a credit balance is
 * worth less than the session. It logs loudly instead.
 *
 * Limits are deliberately far above real use. Ten participants working hard
 * for three hours land nowhere near them, so the first thing to trip one is
 * abuse rather than a busy afternoon.
 */

const WINDOW_SECONDS = 300;   // five minutes

export const COSTS = {
  // name:        [per-caller, global, cost]  within one five-minute window
  chat:            { limit: 40,  globalLimit: 400, cost: 1 },
  'ingest-document': { limit: 30,  globalLimit: 200, cost: 1 },
  'imagine-result': { limit: 10,  globalLimit: 60,  cost: 3 },
  'describe-photo': { limit: 30,  globalLimit: 300, cost: 1 },
  'enrich-plan':   { limit: 30,  globalLimit: 300, cost: 1 },
  'design-joinery': { limit: 30,  globalLimit: 300, cost: 1 },
  'synthesize-target-json': { limit: 30, globalLimit: 300, cost: 1 },
  'modify-target-json': { limit: 40, globalLimit: 400, cost: 1 },
};

function workerBase() {
  const root = String(process.env.COLLAB_API_URL || process.env.VITE_COLLAB_API_URL || '').replace(/\/$/, '');
  if (!root) return null;
  return root.endsWith('/api/collaboration') ? root : `${root}/api/collaboration`;
}

/**
 * Who is calling.
 *
 * Vercel puts the client address in x-forwarded-for. It is spoofable, which
 * matters less than it sounds: the global ceiling is the limit that actually
 * bounds the bill, and it does not care who anyone claims to be.
 */
function callerKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/**
 * Returns null to proceed, or a { status, body } to send back instead.
 */
export async function checkRateLimit(req, name) {
  const config = COSTS[name];
  if (!config) return null;

  const base = workerBase();
  if (!base) {
    // No Worker configured at all — local development, or a deployment without
    // collaboration. Nothing to count against, so nothing to enforce.
    return null;
  }

  try {
    const controller = new AbortController();
    // The limiter must never be the reason a request is slow. If D1 cannot
    // answer in a second, proceed unlimited and say so in the logs.
    const timer = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`${base}/limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, caller: callerKey(req), ...config, windowSeconds: WINDOW_SECONDS }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[rate-limit] ${name}: worker returned ${res.status}, allowing`);
      return null;
    }
    const verdict = await res.json();
    if (verdict.ok) return null;

    console.warn(`[rate-limit] ${name}: ${verdict.scope} limit hit (${verdict.count}/${verdict.limit})`);
    return {
      status: 429,
      headers: { 'Retry-After': String(verdict.retryAfter || WINDOW_SECONDS) },
      body: {
        error: verdict.scope === 'global'
          ? 'This workspace has reached its AI usage limit for the moment. It will clear shortly.'
          : 'Too many requests from this connection. Wait a moment and try again.',
        retryAfter: verdict.retryAfter || WINDOW_SECONDS,
      },
    };
  } catch (err) {
    console.warn(`[rate-limit] ${name}: ${err.name === 'AbortError' ? 'timed out' : err.message}, allowing`);
    return null;
  }
}

/**
 * Wrap a Vercel handler so it is limited before it spends anything.
 *
 * Named rather than inferred from the filename: an endpoint that is renamed
 * would otherwise silently start counting into a fresh bucket.
 */
export function withRateLimit(name, handler) {
  return async function limited(req, res) {
    const rejection = await checkRateLimit(req, name);
    if (rejection) {
      for (const [key, value] of Object.entries(rejection.headers || {})) res.setHeader(key, value);
      return res.status(rejection.status).json(rejection.body);
    }
    return handler(req, res);
  };
}
