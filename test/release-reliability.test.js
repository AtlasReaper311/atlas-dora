// Release correlation tests: deterministic fixtures, no network, and the
// honesty properties asserted directly: mixed-day exclusion, completed
// post days only, insufficiency instead of implied safety, and the
// correlation flag on every record.

import { describe, expect, it } from "vitest";
import {
  correlateReleases,
  resolveServiceId
} from "../src/release-reliability.js";

const NOW = Date.parse("2026-07-19T12:00:00Z");

const OBJECTIVES = [
  { service_id: "atlas-notify", component: "notify" },
  { service_id: "ramone-trigger", component: "ramone_trigger" },
  { service_id: "specular-edge", component: "specular_edge" }
];

function deployEvent(repo, ts) {
  return { level: "success", title: `Deployed: ${repo}`, ts };
}

function steadyDays(start, count, ok, total, avgMs) {
  const days = {};
  let cursor = Date.parse(`${start}T00:00:00Z`);
  for (let index = 0; index < count; index += 1) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    days[day] = { ok, total, ms_sum: ok * avgMs, ms_count: ok };
    cursor += 86400000;
  }
  return days;
}

function slo(componentDays) {
  return {
    components: Object.fromEntries(
      Object.entries(componentDays).map(([name, days]) => [name, { days }])
    )
  };
}

describe("resolveServiceId", () => {
  it("maps a repository straight to its measured service", () => {
    expect(resolveServiceId("atlas-notify", OBJECTIVES)).toBe("atlas-notify");
  });

  it("follows the documented repository-to-worker aliases", () => {
    expect(resolveServiceId("ramone-voice-trigger", OBJECTIVES)).toBe("ramone-trigger");
    expect(resolveServiceId("specular-telemetry", OBJECTIVES)).toBe("specular-edge");
  });

  it("returns null for repositories without a measured service", () => {
    expect(resolveServiceId("atlas-systems", OBJECTIVES)).toBe(null);
  });
});

describe("correlateReleases", () => {
  it("excludes the mixed release day and uses completed days only", () => {
    const days = steadyDays("2026-07-12", 7, 144, 144, 180);
    const result = correlateReleases({
      events: [deployEvent("atlas-notify", "2026-07-15T14:00:00Z")],
      slo: slo({ notify: days }),
      objectives: OBJECTIVES,
      journeyState: "healthy",
      nowMs: NOW
    });

    const release = result.releases[0];
    expect(release.windows.excluded_mixed_day).toBe("2026-07-15");
    expect(release.windows.pre_days).toEqual([
      "2026-07-12",
      "2026-07-13",
      "2026-07-14"
    ]);
    // The 19th is today and incomplete, so post stops at the 18th.
    expect(release.windows.post_days).toEqual([
      "2026-07-16",
      "2026-07-17",
      "2026-07-18"
    ]);
    expect(release.correlation_not_causation).toBe(true);
    expect(release.scheduled_journey_state).toBe("healthy");
    expect(release.evidence_sufficiency).toBe("sufficient");
    expect(release.confidence).toBe("high");
    expect(release.suspected_regression).toBe(false);
  });

  it("flags a post-release availability drop as suspected regression", () => {
    const days = {
      ...steadyDays("2026-07-12", 3, 144, 144, 180),
      ...steadyDays("2026-07-16", 3, 120, 144, 180)
    };
    const result = correlateReleases({
      events: [deployEvent("atlas-notify", "2026-07-15T09:30:00Z")],
      slo: slo({ notify: days }),
      objectives: OBJECTIVES,
      journeyState: "healthy",
      nowMs: NOW
    });

    const release = result.releases[0];
    expect(release.deltas.availability_pct_change).toBeLessThan(-10);
    expect(release.suspected_regression).toBe(true);
    expect(release.evidence_sufficiency).toBe("sufficient");
  });

  it("flags a large latency rise even when availability holds", () => {
    const days = {
      ...steadyDays("2026-07-12", 3, 144, 144, 180),
      ...steadyDays("2026-07-16", 3, 144, 144, 400)
    };
    const result = correlateReleases({
      events: [deployEvent("atlas-notify", "2026-07-15T09:30:00Z")],
      slo: slo({ notify: days }),
      objectives: OBJECTIVES,
      journeyState: "degraded",
      nowMs: NOW
    });

    const release = result.releases[0];
    expect(release.deltas.availability_pct_change).toBe(0);
    expect(release.deltas.avg_ms_change).toBe(220);
    expect(release.suspected_regression).toBe(true);
  });

  it("reports a release with no post evidence as insufficient, never safe", () => {
    const days = steadyDays("2026-07-15", 4, 144, 144, 180);
    const result = correlateReleases({
      events: [deployEvent("atlas-notify", "2026-07-18T22:00:00Z")],
      slo: slo({ notify: days }),
      objectives: OBJECTIVES,
      journeyState: "healthy",
      nowMs: NOW
    });

    const release = result.releases[0];
    expect(release.windows.post_days).toEqual([]);
    expect(release.post.samples).toBe(0);
    expect(release.evidence_sufficiency).toBe("insufficient");
    expect(release.suspected_regression).toBe(null);
    expect(release.confidence).toBe("none");
  });

  it("counts unmapped and unparseable deploys in the basis instead of dropping them silently", () => {
    const days = steadyDays("2026-07-12", 7, 144, 144, 180);
    const result = correlateReleases({
      events: [
        deployEvent("atlas-systems", "2026-07-15T10:00:00Z"),
        { level: "success", title: "Deployed: atlas-notify", ts: "not-a-time" },
        deployEvent("atlas-notify", "2026-07-15T14:00:00Z")
      ],
      slo: slo({ notify: days }),
      objectives: OBJECTIVES,
      journeyState: null,
      nowMs: NOW
    });

    expect(result.releases).toHaveLength(1);
    expect(result.basis).toMatch(/1 deploys had no measured service/);
    expect(result.basis).toMatch(/1 were unparseable/);
    expect(result.releases[0].scheduled_journey_state).toBe("unknown");
  });

  it("emits the versioned schema with freshness metadata", () => {
    const result = correlateReleases({
      events: [],
      slo: slo({}),
      objectives: OBJECTIVES,
      journeyState: "healthy",
      nowMs: NOW
    });
    expect(result.schema_version).toBe(
      "atlas-control-plane/release-reliability-correlation/v1"
    );
    expect(result.generated_at).toBe("2026-07-19T12:00:00Z");
    expect(result.stale_after).toBe("2026-07-19T12:05:00Z");
    expect(result.releases).toEqual([]);
  });
});
