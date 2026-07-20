import { describe, expect, it } from "vitest";

import { sanitizeMetrics, sanitizeReleases } from "../src/public-boundary.js";

describe("public DORA boundary", () => {
  it("removes repository-level deployment frequency breakdowns", () => {
    const result = sanitizeMetrics({
      ok: true,
      deploymentFrequency: {
        perWeek: 4.2,
        totalInWindow: 12,
        byRepo: {
          "public-service": 8,
          "owner-private-service": 4,
        },
      },
    });

    expect(result.deploymentFrequency).toEqual({
      perWeek: 4.2,
      totalInWindow: 12,
    });
    expect(result.deploymentFrequency.byRepo).toBeUndefined();
  });

  it("removes repository identity from release correlation records", () => {
    const result = sanitizeReleases({
      ok: true,
      releases: [
        {
          repository: "AtlasReaper311/owner-private-service",
          service_id: "public-service",
          evidence_sufficiency: "sufficient",
        },
      ],
    });

    expect(result.releases[0]).toEqual({
      service_id: "public-service",
      evidence_sufficiency: "sufficient",
    });
  });
});
