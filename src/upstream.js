// Upstream sources for DORA metrics computation.
//
// Each of these lives in its own Worker (atlas-notify, atlas-blackbox,
// deploy-watch), all routed on the api.atlas-systems.uk zone. Calling them
// by public hostname from inside another Worker on the SAME zone re-enters
// the Cloudflare edge from inside the edge; that round trip is where the
// intermittent 522s came from. A service binding calls the target Worker's
// fetch handler directly, with no DNS resolution and no TLS handshake.
// atlas-blackbox already uses this exact pattern for its own ATLAS_NOTIFY
// binding; this file brings atlas-dora in line with that convention.
 
const UPSTREAM_TIMEOUT_MS = 5000;
 
const UPSTREAMS = {
  notify: {
    binding: "ATLAS_NOTIFY",
    name: "atlas-notify",
    url: "https://atlas-notify/notify/recent?limit=200"
  },
  blackbox: {
    binding: "ATLAS_BLACKBOX",
    name: "atlas-blackbox",
    url: "https://atlas-blackbox/blackbox/incidents"
  },
  deployWatch: {
    binding: "DEPLOY_WATCH",
    name: "deploy-watch",
    url: "https://deploy-watch/deploy-watch/latest"
  }
};
 
async function fetchViaBinding(service, url, label) {
  if (!service) {
    throw new Error(`${label}: service binding not configured in wrangler.jsonc`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await service.fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${label} timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
    }
    throw new Error(`${label} failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}
 
function normalizeNotify(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  return events.filter((event) => event && typeof event === "object");
}
 
function normalizeBlackbox(data) {
  const incidents = Array.isArray(data?.incidents) ? data.incidents : [];
  return incidents.filter((incident) => incident && typeof incident === "object");
}
 
function normalizeDeployWatch(data) {
  if (!data || typeof data !== "object") return null;
  return {
    deployId: data.deployId ?? null,
    status: data.status ?? null,
    branch: data.branch ?? null,
    commitSha: data.commitSha ?? null,
    createdOn: data.createdOn ?? null,
    checkedAt: data.checkedAt ?? null
  };
}
 
export async function fetchEstate(env) {
  const [notify, blackbox, deployWatch] = await Promise.allSettled([
    fetchViaBinding(env[UPSTREAMS.notify.binding], UPSTREAMS.notify.url, UPSTREAMS.notify.name),
    fetchViaBinding(env[UPSTREAMS.blackbox.binding], UPSTREAMS.blackbox.url, UPSTREAMS.blackbox.name),
    fetchViaBinding(env[UPSTREAMS.deployWatch.binding], UPSTREAMS.deployWatch.url, UPSTREAMS.deployWatch.name)
  ]);
 
  const degraded = [];
  let events = [];
  let incidents = [];
  let latestDeploy = null;
 
  if (notify.status === "fulfilled") {
    events = normalizeNotify(notify.value);
  } else {
    degraded.push({ upstream: UPSTREAMS.notify.name, reason: notify.reason.message });
  }
 
  if (blackbox.status === "fulfilled") {
    incidents = normalizeBlackbox(blackbox.value);
  } else {
    degraded.push({ upstream: UPSTREAMS.blackbox.name, reason: blackbox.reason.message });
  }
 
  if (deployWatch.status === "fulfilled") {
    latestDeploy = normalizeDeployWatch(deployWatch.value);
  } else {
    degraded.push({ upstream: UPSTREAMS.deployWatch.name, reason: deployWatch.reason.message });
  }
 
  return { events, incidents, latestDeploy, degraded, allFailed: degraded.length === 3 };
}
 
export const UPSTREAM_DESCRIPTORS = Object.values(UPSTREAMS).map((u) => ({
  name: u.name,
  via: `service binding ${u.binding}`
}));
