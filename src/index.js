/**
 * atlas-dora: DORA metrics for the Atlas Systems estate, computed from the
 * estate's own public read endpoints. Pure downstream consumer: no secrets,
 * no auth, no writes to anything except its own KV cache.
 *
 * GET /dora/metrics   the numbers, cached ~5 min, x-dora-cache: HIT|MISS
 * GET /dora/health    is this Worker itself alive (no upstream calls)
 * GET /dora/_meta     estate self-description contract
 *
 * Routes also answer without the /dora prefix so the Worker works on both
 * its workers.dev URL and the routed path under api.atlas-systems.uk.
 */

import { computeMetrics, trendAgainst } from './metrics.js';
import { fetchEstate, UPSTREAMS } from './upstream.js';

const CACHE_KEY = 'metrics:v1';
const LAST_KEY = 'metrics:last';
const CACHE_TTL_SECONDS = 300; // 5 minutes: fresh enough for a dashboard, kind to upstreams.

const META = {
  name: 'atlas-dora',
  role: 'Computes DORA metrics (deployment frequency, change failure rate, MTTR) from the estate\'s public event and incident endpoints.',
  endpoints: ['/dora/metrics', '/dora/health', '/dora/_meta'],
  upstreams: Object.values(UPSTREAMS),
  source: 'https://github.com/AtlasReaper311/atlas-dora',
  notes: 'Read-only downstream consumer. CFR and MTTR are correlation heuristics; each response reports its own basis.',
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  // Without this, browser JS on atlas-systems.uk cannot read the cache
  // header even though curl can. Banked estate lesson: test the browser
  // context, not just curl.
  'access-control-expose-headers': 'x-dora-cache',
};

function json(body, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/** Strip an optional /dora prefix so both mount points serve one router. */
function normalizePath(pathname) {
  const stripped = pathname.startsWith('/dora/') || pathname === '/dora'
    ? pathname.slice('/dora'.length)
    : pathname;
  return stripped === '' ? '/' : stripped;
}

async function handleMetrics(env) {
  // KV cache first. A dashboard refreshing every few seconds should not
  // multiply into upstream fan-out; 5 minutes staleness is the honest
  // price, and the header says which you got.
  const cached = await env.DORA_CACHE.get(CACHE_KEY);
  if (cached !== null) {
    return new Response(cached, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...CORS_HEADERS,
        'x-dora-cache': 'HIT',
      },
    });
  }

  const estate = await fetchEstate();
  if (estate.allFailed) {
    // Nothing to compute from. 503, uncached, with every reason listed:
    // a cached error would outlive the outage it describes.
    return json(
      { ok: false, error: 'all upstreams unreachable', degraded: estate.degraded },
      { status: 503, extraHeaders: { 'x-dora-cache': 'MISS' } },
    );
  }

  const metrics = computeMetrics({
    events: estate.events,
    incidents: estate.incidents,
    latestDeploy: estate.latestDeploy,
    nowMs: Date.now(),
  });

  // Trend against the previous computation. metrics:last has no TTL: it is
  // the durable "previous" snapshot, only overwritten by the next MISS.
  let previous = null;
  try {
    const raw = await env.DORA_CACHE.get(LAST_KEY);
    previous = raw === null ? null : JSON.parse(raw);
  } catch {
    previous = null; // an unparseable snapshot means no trend, not an error
  }

  const body = {
    ok: true,
    computedAt: new Date().toISOString(),
    ...metrics,
    trend: trendAgainst(previous, metrics),
    degraded: estate.degraded,
  };
  const serialized = JSON.stringify(body, null, 2);

  await env.DORA_CACHE.put(CACHE_KEY, serialized, { expirationTtl: CACHE_TTL_SECONDS });
  await env.DORA_CACHE.put(LAST_KEY, JSON.stringify(metrics));

  return new Response(serialized, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
      'x-dora-cache': 'MISS',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return json({ ok: false, error: 'method not allowed' }, { status: 405 });
    }

    const path = normalizePath(new URL(request.url).pathname);

    if (path === '/metrics') {
      try {
        return await handleMetrics(env);
      } catch (error) {
        // Last-resort catch so an unforeseen bug is a JSON 500 with a
        // stable public message, never a blank Cloudflare error page. The
        // actionable detail stays in structured Workers logs.
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          message: 'metrics request failed',
          error: message,
          path: new URL(request.url).pathname,
        }));
        return json({ ok: false, error: 'internal server error' }, { status: 500 });
      }
    }
    if (path === '/health') {
      // Self only, deliberately: this answers "is atlas-dora up", and the
      // metrics endpoint's degraded[] answers "is the estate up". Mixing
      // them would make this Worker report sick when a neighbour is.
      return json({ ok: true, service: 'atlas-dora', at: new Date().toISOString() });
    }
    if (path === '/_meta') {
      return json(META);
    }
    return json({ ok: false, error: 'not found', see: '/dora/_meta' }, { status: 404 });
  },
};
