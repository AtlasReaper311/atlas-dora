// Release and reliability correlation: for each deploy the notify ring
// buffer recorded, compare the probe counters before and after it.
//
// Honesty contract, same spirit as metrics.js: the estate has no explicit
// deploy-to-probe link, so this is correlation evidence and every record
// says so (`correlation_not_causation: true`). The counters are per-day
// aggregates, so windows are whole UTC days: the release day itself mixes
// pre and post traffic and is excluded, `pre` is up to three full days
// before, `post` is up to three completed days after. A release with no
// post-release evidence is `insufficient`, never safe. Suspected
// regression is a flag with stated thresholds, not a verdict.

import { isDeployEvent, deployRepo, parseTs } from "./metrics.js";

const MAX_RELEASES = 30;
const WINDOW_DAYS = 3;
const SUFFICIENT_SAMPLES = 288;
const REGRESSION_AVAILABILITY_DROP_PCT = 0.5;
const REGRESSION_LATENCY_INCREASE_PCT = 25;

// Two repositories deploy Workers whose names deliberately diverge from
// the repository name; both divergences are documented in
// atlas-infra/docs/decisions.md under "Worker naming and route layering".
const REPO_SERVICE_ALIASES = {
  "ramone-voice-trigger": "ramone-trigger",
  "specular-telemetry": "specular-edge"
};

/** Round half away from zero, mirroring the estate evaluator sequence. */
function roundPlaces(value, places) {
  const factor = 10 ** places;
  const scaled = Math.floor(Math.abs(value) * factor + 0.5) / factor;
  return value >= 0 ? scaled : -scaled;
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftDay(day, offset) {
  const ms = Date.parse(`${day}T00:00:00Z`) + offset * 86400000;
  return utcDay(ms);
}

export function resolveServiceId(repo, objectives) {
  const byService = new Set(objectives.map((objective) => objective.service_id));
  if (byService.has(repo)) return repo;
  const alias = REPO_SERVICE_ALIASES[repo];
  if (alias && byService.has(alias)) return alias;
  return null;
}

function windowStats(days, dayList) {
  let ok = 0;
  let total = 0;
  let msSum = 0;
  let msCount = 0;
  for (const day of dayList) {
    const bucket = days[day];
    if (!bucket) continue;
    ok += bucket.ok ?? 0;
    total += bucket.total ?? 0;
    msSum += bucket.ms_sum ?? 0;
    msCount += bucket.ms_count ?? 0;
  }
  return {
    availability_pct: total > 0 ? roundPlaces((ok / total) * 100, 2) : null,
    avg_ms: msCount > 0 ? roundPlaces(msSum / msCount, 0) : null,
    samples: total,
    failureRate: total > 0 ? (total - ok) / total : null
  };
}

function presentDays(days, dayList) {
  return dayList.filter((day) => Boolean(days[day]));
}

function correlateOne(event, serviceId, component, nowMs) {
  const deployMs = parseTs(event.ts);
  if (deployMs === null) return null;
  const releaseDay = utcDay(deployMs);
  const today = utcDay(nowMs);
  const days = component?.days ?? {};

  const preCandidates = [];
  for (let offset = WINDOW_DAYS; offset >= 1; offset -= 1) {
    preCandidates.push(shiftDay(releaseDay, -offset));
  }
  const postCandidates = [];
  for (let offset = 1; offset <= WINDOW_DAYS; offset += 1) {
    const day = shiftDay(releaseDay, offset);
    // Only completed UTC days count as post-release evidence; today's
    // partial bucket would understate whatever it eventually shows.
    if (day < today) postCandidates.push(day);
  }
  const preDays = presentDays(days, preCandidates);
  const postDays = presentDays(days, postCandidates);

  const pre = windowStats(days, preDays);
  const post = windowStats(days, postDays);

  let sufficiency = "insufficient";
  if (pre.samples >= SUFFICIENT_SAMPLES && post.samples >= SUFFICIENT_SAMPLES) {
    sufficiency = "sufficient";
  } else if (pre.samples > 0 && post.samples > 0) {
    sufficiency = "partial";
  }

  const deltas = {
    availability_pct_change:
      pre.availability_pct !== null && post.availability_pct !== null
        ? roundPlaces(post.availability_pct - pre.availability_pct, 2)
        : null,
    avg_ms_change:
      pre.avg_ms !== null && post.avg_ms !== null
        ? roundPlaces(post.avg_ms - pre.avg_ms, 0)
        : null,
    failure_rate_change:
      pre.failureRate !== null && post.failureRate !== null
        ? roundPlaces(post.failureRate - pre.failureRate, 4)
        : null
  };

  let suspected = null;
  if (sufficiency !== "insufficient" && deltas.availability_pct_change !== null) {
    const availabilityDrop =
      deltas.availability_pct_change <= -REGRESSION_AVAILABILITY_DROP_PCT;
    const latencyRise =
      pre.avg_ms !== null &&
      pre.avg_ms > 0 &&
      post.avg_ms !== null &&
      ((post.avg_ms - pre.avg_ms) / pre.avg_ms) * 100 >
        REGRESSION_LATENCY_INCREASE_PCT;
    suspected = availabilityDrop || latencyRise;
  }

  let confidence = "none";
  if (sufficiency === "sufficient") {
    confidence = postDays.length === WINDOW_DAYS ? "high" : "medium";
  } else if (sufficiency === "partial") {
    confidence = "low";
  }

  return {
    repository: `AtlasReaper311/${deployRepo(event)}`,
    service_id: serviceId,
    deploy_event_at: new Date(deployMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    deploy_event_source: "atlas-notify/notify/recent",
    windows: {
      pre_days: preDays,
      post_days: postDays,
      excluded_mixed_day: releaseDay
    },
    pre: {
      availability_pct: pre.availability_pct,
      avg_ms: pre.avg_ms,
      samples: pre.samples
    },
    post: {
      availability_pct: post.availability_pct,
      avg_ms: post.avg_ms,
      samples: post.samples
    },
    deltas,
    scheduled_journey_state: "unknown",
    verification: { state: "unavailable-from-public-surface", reference: null },
    evidence_sufficiency: sufficiency,
    suspected_regression: suspected,
    correlation_not_causation: true,
    confidence
  };
}

/**
 * Correlate every detected deploy against the probe counters.
 *
 * `slo` is the /v1/slo response body; `objectives` come from
 * /v1/reliability/objectives; `journeyState` is the scheduled journey
 * component's current verdict from /v1/stats, applied to every record
 * because it describes the estate journey schedule, not one release.
 */
export function correlateReleases({ events, slo, objectives, journeyState, nowMs }) {
  const componentByService = new Map(
    objectives.map((objective) => [objective.service_id, objective.component])
  );
  const releases = [];
  const skipped = { unmapped: 0, unparseable: 0 };

  for (const event of events) {
    if (releases.length >= MAX_RELEASES) break;
    if (!isDeployEvent(event)) continue;
    const repo = deployRepo(event);
    if (!repo) {
      skipped.unparseable += 1;
      continue;
    }
    const serviceId = resolveServiceId(repo, objectives);
    if (!serviceId) {
      skipped.unmapped += 1;
      continue;
    }
    const component = slo?.components?.[componentByService.get(serviceId)];
    const record = correlateOne(event, serviceId, component, nowMs);
    if (!record) {
      skipped.unparseable += 1;
      continue;
    }
    if (journeyState) record.scheduled_journey_state = journeyState;
    releases.push(record);
  }

  const generatedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    schema_version: "atlas-control-plane/release-reliability-correlation/v1",
    generated_at: generatedAt,
    stale_after: new Date(nowMs + 300000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    basis:
      `deploy events from the atlas-notify ring buffer correlated against ` +
      `atlas-api-public per-day probe counters; release day excluded as mixed; ` +
      `windows are up to ${WINDOW_DAYS} full UTC days each side; ` +
      `${skipped.unmapped} deploys had no measured service and ` +
      `${skipped.unparseable} were unparseable`,
    releases
  };
}
