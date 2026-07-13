/**
 * Upstream reads. atlas-dora is a pure downstream consumer of the estate's
 * public read endpoints: no secrets, no auth headers, no writes. That is
 * why this Worker can be public code and a public API at the same time.
 *
 * Each fetch is bounded by its own AbortController: one slow upstream
 * costs its own 5 seconds, not the whole response. Callers use allSettled
 * so a partial estate produces partial metrics with a degraded[] list, and
 * only a fully dark estate produces a 503.
 */

const UPSTREAM_TIMEOUT_MS = 5000;

export const UPSTREAMS = {
  notify: 'https://api.atlas-systems.uk/notify/recent?limit=200',
  blackbox: 'https://api.atlas-systems.uk/blackbox/incidents',
  deployWatch: 'https://api.atlas-systems.uk/deploy-watch/latest',
};

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${url} timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
    }
    throw new Error(`${url} failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Normalise /notify/recent to an events array. Shape confirmed live 2026-07-13. */
function normalizeNotify(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  return events.filter((event) => event && typeof event === 'object');
}

/** Normalise /blackbox/incidents to an incidents array. Shape confirmed live 2026-07-13. */
function normalizeBlackbox(data) {
  const incidents = Array.isArray(data?.incidents) ? data.incidents : [];
  return incidents.filter((incident) => incident && typeof incident === 'object');
}

/** Normalise /deploy-watch/latest snapshot. Shape confirmed live 2026-07-13. */
function normalizeDeployWatch(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    deployId: data.deployId ?? null,
    status: data.status ?? null,
    branch: data.branch ?? null,
    commitSha: data.commitSha ?? null,
    createdOn: data.createdOn ?? null,
    checkedAt: data.checkedAt ?? null,
  };
}

/**
 * Fetch all three upstreams in parallel. Returns
 * { events, incidents, latestDeploy, degraded } where degraded lists each
 * failed upstream with its reason. Empty arrays are the degraded default:
 * metrics over a missing upstream honestly show as null/zero with the gap
 * named, rather than the whole endpoint dying because one Worker blinked.
 */
export async function fetchEstate() {
  const [notify, blackbox, deployWatch] = await Promise.allSettled([
    fetchJson(UPSTREAMS.notify),
    fetchJson(UPSTREAMS.blackbox),
    fetchJson(UPSTREAMS.deployWatch),
  ]);

  const degraded = [];
  let events = [];
  let incidents = [];
  let latestDeploy = null;

  if (notify.status === 'fulfilled') {
    events = normalizeNotify(notify.value);
  } else {
    degraded.push({ upstream: 'atlas-notify', reason: notify.reason.message });
  }
  if (blackbox.status === 'fulfilled') {
    incidents = normalizeBlackbox(blackbox.value);
  } else {
    degraded.push({ upstream: 'atlas-blackbox', reason: blackbox.reason.message });
  }
  if (deployWatch.status === 'fulfilled') {
    latestDeploy = normalizeDeployWatch(deployWatch.value);
  } else {
    degraded.push({ upstream: 'deploy-watch', reason: deployWatch.reason.message });
  }

  return { events, incidents, latestDeploy, degraded, allFailed: degraded.length === 3 };
}
