/**
 * Pure DORA computations. No fetch, no KV, no Date.now() except where
 * injected: everything here is a function from upstream payloads to
 * numbers, which is what makes it testable and what keeps index.js thin.
 *
 * Honesty contract for this whole file: the estate has no explicit
 * "deploy X caused incident Y" or "incident Y recovered at Z" links, so
 * change failure rate and MTTR are correlation heuristics over the notify
 * ring buffer and blackbox list. Every heuristic is commented with exactly
 * what it assumes, and the response reports its own basis (window, event
 * counts, exclusions) so a reader can judge the numbers instead of
 * trusting them blind.
 */

const DEPLOY_CORRELATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Words too common in event text to indicate the same service.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'has', 'been', 'is',
  'was', 'and', 'or', 'with', 'from', 'via', 'alert', 'infra', 'health',
  'minutes', 'production', 'deployed', 'blocked', 'failed', 'failure',
]);

/**
 * Parse the estate's two timestamp dialects (ISO-8601 with trailing Z,
 * epoch milliseconds) to a millisecond number, or null on junk. Mirrors
 * parse_ts in atlas-cli: same estate, same dialects, same rule that one
 * odd record degrades to a gap, not a crash.
 */
export function parseTs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic threshold: anything above ~2001 in epoch-seconds terms
    // read as ms. The estate only emits ms, this just survives seconds.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * A notify event counts as a successful deploy when its level is success
 * and its title carries the deploy convention. Confirmed live 2026-07-13:
 * success deploys look like title "Deployed: atlas-notify", message
 * "Deployed to production [6c79014]". The looser contains-'deploy' branch
 * catches any event/title drift without silently widening to unrelated
 * successes (level must still be success).
 */
export function isDeployEvent(event) {
  if (!event || String(event.level).toLowerCase() !== 'success') return false;
  const title = String(event.title || '');
  if (title.startsWith('Deployed:')) return true;
  const haystack = `${title} ${event.event || ''}`.toLowerCase();
  return haystack.includes('deploy');
}

/** Repo name from the deploy title convention, or null. */
export function deployRepo(event) {
  const title = String(event?.title || '');
  if (title.startsWith('Deployed:')) return title.slice('Deployed:'.length).trim() || null;
  return null;
}

/** Blackbox drill incidents are synthetic tests, never DORA data. */
export function isDrillIncident(incident) {
  return String(incident?.trigger?.dialect || '').toLowerCase() === 'drill';
}

/** Tokenise event text for the MTTR service-matching heuristic. */
export function tokens(event) {
  const text = `${event?.event || ''} ${event?.title || ''}`.toLowerCase();
  return new Set(
    text
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function overlap(setA, setB) {
  for (const item of setA) if (setB.has(item)) return true;
  return false;
}

/**
 * The reporting window is honest rather than round: it runs from the
 * oldest event actually present in the ring buffer to now. atlas-notify
 * keeps the last 200 events, so "deploys per week" over a fixed 30 days
 * would silently undercount whenever the buffer covers less than that.
 * Reporting the real observed span, and the span itself in the response,
 * keeps the number meaningful.
 */
export function computeWindow(events, nowMs) {
  const stamps = events.map((event) => parseTs(event.ts)).filter((ms) => ms !== null);
  if (stamps.length === 0) return null;
  const from = Math.min(...stamps);
  return { fromMs: from, toMs: nowMs, days: (nowMs - from) / 86400000 };
}

/** Deploys in the window, plus per-repo counts, plus frequency per week. */
export function deploymentFrequency(events, windowInfo) {
  const deploys = events.filter(isDeployEvent);
  const byRepo = {};
  for (const event of deploys) {
    const repo = deployRepo(event) || '(unlabelled)';
    byRepo[repo] = (byRepo[repo] || 0) + 1;
  }
  const days = windowInfo ? Math.max(windowInfo.days, 1 / 24) : null;
  return {
    total: deploys.length,
    perWeek: days === null ? null : Number(((deploys.length / days) * 7).toFixed(2)),
    byRepo,
    deploys,
  };
}

/**
 * Change failure rate, deploy-correlation heuristic.
 *
 * Assumption, stated plainly: a real (non-drill) blackbox incident whose
 * trigger fires within 30 minutes AFTER a successful deploy is attributed
 * to that deploy. That is correlation, not causation: an unrelated outage
 * 20 minutes after a deploy counts, and a deploy that breaks something 40
 * minutes later does not. With no deploy->incident link in the estate's
 * data, this window is the defensible middle; the response carries the
 * window size so the reader knows the rule that produced the number.
 */
export function changeFailureRate(deploys, incidents, correlationWindowMs = DEPLOY_CORRELATION_WINDOW_MS) {
  if (deploys.length === 0) {
    return { rate: null, failedDeploys: 0, totalDeploys: 0, correlationWindowMinutes: correlationWindowMs / 60000, note: 'no deploys in window' };
  }
  const triggerTimes = incidents
    .filter((incident) => !isDrillIncident(incident))
    .map((incident) => parseTs(incident?.trigger?.ts))
    .filter((ms) => ms !== null);

  let failed = 0;
  for (const deploy of deploys) {
    const deployMs = parseTs(deploy.ts);
    if (deployMs === null) continue;
    const hit = triggerTimes.some((ms) => ms > deployMs && ms - deployMs <= correlationWindowMs);
    if (hit) failed += 1;
  }
  return {
    rate: Number((failed / deploys.length).toFixed(3)),
    failedDeploys: failed,
    totalDeploys: deploys.length,
    correlationWindowMinutes: correlationWindowMs / 60000,
  };
}

/**
 * Mean time to recovery.
 *
 * Assumption, stated plainly: recovery of an incident is the first
 * success-level notify event after the trigger whose text shares a
 * meaningful token with the trigger text ("ramone", "sentinel", a repo
 * name). Incidents with no token overlap in any later success event are
 * reported as unmeasured rather than guessed: a wrong MTTR is worse than
 * an honest "n of m measured".
 */
export function meanTimeToRecovery(events, incidents) {
  const successes = events
    .map((event) => ({ ms: parseTs(event.ts), toks: tokens(event), level: String(event.level).toLowerCase() }))
    .filter((entry) => entry.level === 'success' && entry.ms !== null);

  const real = incidents.filter((incident) => !isDrillIncident(incident));
  const durationsMs = [];
  const unmeasured = [];

  for (const incident of real) {
    const triggerMs = parseTs(incident?.trigger?.ts);
    const triggerToks = tokens(incident?.trigger);
    if (triggerMs === null || triggerToks.size === 0) {
      unmeasured.push({ id: incident?.id || '?', reason: 'trigger has no timestamp or no matchable tokens' });
      continue;
    }
    const recovery = successes
      .filter((entry) => entry.ms > triggerMs && overlap(triggerToks, entry.toks))
      .sort((a, b) => a.ms - b.ms)[0];
    if (!recovery) {
      unmeasured.push({ id: incident?.id || '?', reason: 'no matching success event after trigger in the ring buffer' });
      continue;
    }
    durationsMs.push(recovery.ms - triggerMs);
  }

  const mean = durationsMs.length
    ? durationsMs.reduce((sum, ms) => sum + ms, 0) / durationsMs.length
    : null;
  return {
    meanMinutes: mean === null ? null : Number((mean / 60000).toFixed(1)),
    measuredIncidents: durationsMs.length,
    totalRealIncidents: real.length,
    unmeasured,
  };
}

/**
 * Trend against the previous computation (KV key metrics:last). Direction
 * only plus the delta: the panel draws the arrow, the reader judges the
 * size. A missing or unparseable previous snapshot means no trend, shown
 * as flat with delta null, never a fabricated baseline.
 */
export function trendAgainst(previous, current) {
  const fields = [
    ['deploymentFrequencyPerWeek', current?.deploymentFrequency?.perWeek, previous?.deploymentFrequency?.perWeek],
    ['changeFailureRate', current?.changeFailureRate?.rate, previous?.changeFailureRate?.rate],
    ['mttrMinutes', current?.mttr?.meanMinutes, previous?.mttr?.meanMinutes],
  ];
  const trend = {};
  for (const [name, now, before] of fields) {
    if (typeof now !== 'number' || typeof before !== 'number') {
      trend[name] = { dir: 'flat', delta: null };
      continue;
    }
    const delta = Number((now - before).toFixed(3));
    trend[name] = { dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', delta };
  }
  return trend;
}

/** Assemble the full metrics body from normalised upstream payloads. */
export function computeMetrics({ events, incidents, latestDeploy, nowMs }) {
  const windowInfo = computeWindow(events, nowMs);
  const frequency = deploymentFrequency(events, windowInfo);
  const drillExcluded = incidents.filter(isDrillIncident).length;
  const cfr = changeFailureRate(frequency.deploys, incidents);
  const mttr = meanTimeToRecovery(events, incidents);

  return {
    window: windowInfo
      ? {
          from: new Date(windowInfo.fromMs).toISOString(),
          to: new Date(windowInfo.toMs).toISOString(),
          days: Number(windowInfo.days.toFixed(2)),
          basis: `oldest of ${events.length} ring-buffer events to now`,
        }
      : null,
    deploymentFrequency: {
      perWeek: frequency.perWeek,
      totalInWindow: frequency.total,
      byRepo: frequency.byRepo,
    },
    changeFailureRate: cfr,
    mttr,
    drillIncidentsExcluded: drillExcluded,
    latestDeploy,
  };
}
