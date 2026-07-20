<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# atlas-dora

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // atlas-dora                │
│  aggregate delivery and recovery metrics   │
└─────────────────────────────────────────────┘
```

[![Deploy](https://github.com/AtlasReaper311/atlas-dora/actions/workflows/deploy.yml/badge.svg)](https://github.com/AtlasReaper311/atlas-dora/actions/workflows/deploy.yml)
![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f5a623?style=flat-square&labelColor=0a0a0f)
![Cache](https://img.shields.io/badge/cache-Workers%20KV-4ade80?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

A read-only Cloudflare Worker that computes Atlas Systems delivery metrics from existing operational evidence. Public responses keep whole-estate aggregate signals while removing private repository identities and source-level private detail.

## Prerequisites

- Node.js 22.
- npm with the committed `package-lock.json`.
- Wrangler authentication for local manual deployment.
- The existing `DORA_CACHE` Workers KV namespace declared in `wrangler.jsonc`.

GitHub deployment uses the canonical reusable Worker pipeline from `atlas-infra`. Repository secrets are inherited by name; secret values are never committed to this repository.

## Setup

```bash
npm ci
npm run check
```

`npm run check` runs ESLint, Vitest, binding-type validation, and a Wrangler dry run.

## Usage

| Route | Purpose |
| --- | --- |
| `GET /dora/metrics` | Aggregate deployment frequency, change failure rate, MTTR, trend, and degradation state |
| `GET /dora/releases` | Sanitized release and reliability correlation without private repository identity |
| `GET /dora/health` | Side-effect-free Worker liveness probe |
| `GET /dora/_meta` | Public service metadata |

The public route is declared in `wrangler.jsonc` as `api.atlas-systems.uk/dora/*`.

## Metric behaviour

**Deployment frequency.** Successful deployment events are read from the operational event stream. Public output reports aggregate frequency; private repositories can contribute numerically without appearing in repository-level breakdowns.

**Change failure rate.** Non-drill incidents within the configured correlation window after a successful deploy contribute to the aggregate rate. The relationship is correlation rather than causation, so the response reports its basis instead of presenting attribution as certain.

**MTTR.** Recovery is inferred from matching success events after incident triggers. Incidents without sufficient recovery evidence remain explicitly unmeasured.

**Release reliability.** `/dora/releases` compares bounded pre-release and post-release reliability evidence. The mixed release day is excluded, missing post-release evidence cannot become a safe result, and private repository identity is removed from the public projection.

## Degradation

Upstreams are fetched independently with bounded timeouts. Partial upstream failure produces a degraded response; unusable required evidence returns an error rather than an empty healthy result. Cache entries are written only for usable computations.

## Deploy

`.github/workflows/deploy.yml` calls the immutable `atlas-infra` reusable Worker deployment workflow.

A push to `main`, including a merged pull request, validates the repository and then deploys `atlas-dora` to production. `workflow_dispatch` provides the same production path for an explicit manual run from `main`.

The reusable pipeline requires these repository or inherited secrets:

- `CF_WORKERS_DEPLOY_TOKEN`
- `CF_ACCOUNT_ID`
- `DISCORD_API_DEPLOYS_WEBHOOK`
- `NOTIFY_TOKEN` is optional for persistence into the Atlas notification event log

The deployment pipeline runs `npm ci`, a Wrangler dry run, lint, and tests before any production write. Failed validation blocks deployment.

## How it fits into Atlas Systems

`atlas-dora` consumes operational evidence produced by [`atlas-notify`](https://github.com/AtlasReaper311/atlas-notify), [`atlas-blackbox`](https://github.com/AtlasReaper311/atlas-blackbox), [`deploy-watch`](https://github.com/AtlasReaper311/deploy-watch), and [`atlas-api-public`](https://github.com/AtlasReaper311/atlas-api-public). It supplies aggregate delivery and release-reliability signals to the public Atlas Systems surface while the public-private estate boundary prevents private source identities from crossing into those responses.

The transferable principle is to separate the evidence used for engineering measurement from the detail that is safe to publish.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
