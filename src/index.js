import { computeMetrics, trendAgainst } from "./metrics.js";
import { correlateReleases } from "./release-reliability.js";
import { fetchEstate, fetchReleaseSources, UPSTREAM_DESCRIPTORS } from "./upstream.js";

const CACHE_KEY = "metrics:v1";
const LAST_KEY = "metrics:last";
const RELEASES_CACHE_KEY = "releases:v1";
const CACHE_TTL_SECONDS = 300;

const META = {
  name: "atlas-dora",
  description: "Computes aggregate DORA delivery and recovery metrics from Atlas Systems operational evidence.",
  version: "0.1.0",
  status: "live",
  role: "Computes DORA metrics (deployment frequency, change failure rate, MTTR) from the estate's event and incident recorders.",
  endpoints: ["/dora/metrics", "/dora/releases", "/dora/health", "/dora/_meta"],
  upstreams: UPSTREAM_DESCRIPTORS,
  source: "https://github.com/AtlasReaper311/atlas-dora",
  notes: "Read-only downstream consumer, called over Cloudflare Service Bindings rather than public URLs to avoid same-zone edge round-trips. CFR, MTTR, and release correlation are correlation heuristics; each response reports its own basis."
};
 
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  // Without this, browser JS on atlas-systems.uk cannot read the cache
  // header even though curl can. Banked estate lesson: test the browser
  // context, not just curl.
  "access-control-expose-headers": "x-dora-cache"
};
 
function json(body, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}
 
function normalizePath(pathname) {
  const stripped =
    pathname.startsWith("/dora/") || pathname === "/dora"
      ? pathname.slice("/dora".length)
      : pathname;
  return stripped === "" ? "/" : stripped;
}
 
async function handleMetrics(env) {
  const cached = await env.DORA_CACHE.get(CACHE_KEY);
  if (cached !== null) {
    return new Response(cached, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...CORS_HEADERS,
        "x-dora-cache": "HIT"
      }
    });
  }
 
  const estate = await fetchEstate(env);
  if (estate.allFailed) {
    return json(
      { ok: false, error: "all upstreams unreachable", degraded: estate.degraded },
      { status: 503, extraHeaders: { "x-dora-cache": "MISS" } }
    );
  }
 
  const metrics = computeMetrics({
    events: estate.events,
    incidents: estate.incidents,
    latestDeploy: estate.latestDeploy,
    nowMs: Date.now()
  });
 
  let previous = null;
  try {
    const raw = await env.DORA_CACHE.get(LAST_KEY);
    previous = raw === null ? null : JSON.parse(raw);
  } catch {
    previous = null;
  }
 
  const body = {
    ok: true,
    computedAt: new Date().toISOString(),
    ...metrics,
    trend: trendAgainst(previous, metrics),
    degraded: estate.degraded
  };
 
  const serialized = JSON.stringify(body, null, 2);
  await env.DORA_CACHE.put(CACHE_KEY, serialized, { expirationTtl: CACHE_TTL_SECONDS });
  await env.DORA_CACHE.put(LAST_KEY, JSON.stringify(metrics));
 
  return new Response(serialized, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      "x-dora-cache": "MISS"
    }
  });
}
 
async function handleReleases(env) {
  const cached = await env.DORA_CACHE.get(RELEASES_CACHE_KEY);
  if (cached !== null) {
    return new Response(cached, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...CORS_HEADERS,
        "x-dora-cache": "HIT"
      }
    });
  }

  const sources = await fetchReleaseSources(env);
  if (sources.unusable) {
    // Missing inputs cannot become an empty-but-healthy correlation:
    // the honest answer names what is absent and refuses to correlate.
    return json(
      { ok: false, error: "correlation inputs unavailable", degraded: sources.degraded },
      { status: 503, extraHeaders: { "x-dora-cache": "MISS" } }
    );
  }

  const body = {
    ok: true,
    ...correlateReleases({
      events: sources.events,
      slo: sources.slo,
      objectives: sources.objectives,
      journeyState: sources.journeyState,
      nowMs: Date.now()
    }),
    degraded: sources.degraded
  };

  const serialized = JSON.stringify(body, null, 2);
  await env.DORA_CACHE.put(RELEASES_CACHE_KEY, serialized, { expirationTtl: CACHE_TTL_SECONDS });
  return new Response(serialized, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      "x-dora-cache": "MISS"
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json({ ok: false, error: "method not allowed" }, { status: 405 });
    }

    const path = normalizePath(new URL(request.url).pathname);

    if (path === "/metrics") {
      try {
        return await handleMetrics(env);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            message: "metrics request failed",
            error: message,
            path: new URL(request.url).pathname
          })
        );
        return json({ ok: false, error: "internal server error" }, { status: 500 });
      }
    }

    if (path === "/releases") {
      try {
        return await handleReleases(env);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            message: "releases request failed",
            error: message,
            path: new URL(request.url).pathname
          })
        );
        return json({ ok: false, error: "internal server error" }, { status: 500 });
      }
    }
 
    if (path === "/health") {
      return json({ ok: true, service: "atlas-dora", at: new Date().toISOString() });
    }
 
    if (path === "/_meta") {
      return json(META);
    }
 
    return json({ ok: false, error: "not found", see: "/dora/_meta" }, { status: 404 });
  }
};
