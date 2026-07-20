import worker from "./index.js";

function sanitizeMetrics(body) {
  const frequency = body?.deploymentFrequency
    ? {
        perWeek: body.deploymentFrequency.perWeek ?? null,
        totalInWindow: body.deploymentFrequency.totalInWindow ?? 0,
      }
    : body?.deploymentFrequency;

  return {
    ...body,
    deploymentFrequency: frequency,
  };
}

function sanitizeReleases(body) {
  if (!Array.isArray(body?.releases)) return body;
  return {
    ...body,
    releases: body.releases.map((release) => {
      const { repository: _repository, ...publicRelease } = release;
      return publicRelease;
    }),
  };
}

async function sanitizeResponse(response, sanitizer) {
  const body = await response.clone().json();
  if (!response.ok || body?.ok === false) return response;
  const sanitized = sanitizer(body);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(sanitized, null, 2), {
    status: response.status,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const response = await worker.fetch(request, env, ctx);

    if (request.method !== "GET") return response;
    if (path.endsWith("/metrics") || path === "/metrics") {
      return sanitizeResponse(response, sanitizeMetrics);
    }
    if (path.endsWith("/releases") || path === "/releases") {
      return sanitizeResponse(response, sanitizeReleases);
    }
    return response;
  },
};

export { sanitizeMetrics, sanitizeReleases };
