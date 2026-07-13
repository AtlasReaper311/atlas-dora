# atlas-dora

A Cloudflare Worker that computes the estate's DORA metrics (deployment
frequency, change failure rate, mean time to recovery) from the estate's own
public read endpoints, and a drop-in panel for the Lab page.

The point: the estate already emits every event needed to measure its own
delivery performance. atlas-notify's ring buffer records deploys and
failures, atlas-blackbox records incidents, deploy-watch records the latest
deploy. This Worker is a pure downstream consumer of those three: **no
secrets, no auth, no writes** beyond its own KV cache, which is why the code
and the API can both be public.

## Endpoints

| Route | |
| --- | --- |
| `GET /dora/metrics` | the numbers, cached ~5 min, `x-dora-cache: HIT` or `MISS` |
| `GET /dora/health` | is atlas-dora itself alive (no upstream calls, deliberately) |
| `GET /dora/_meta` | estate self-description contract |

Routes also answer without the `/dora` prefix so the workers.dev URL works
before the route is attached.

## How the numbers are computed, honestly

The estate has no explicit "deploy X caused incident Y" or "incident Y
recovered at Z" links, so two of the three metrics are correlation
heuristics. Each response reports its own basis so a reader can judge the
numbers rather than trust them.

**Deployment frequency.** Deploy events are read from the notify ring
buffer: level `success` with the confirmed live title convention
`Deployed: <repo>` (plus a looser contains-"deploy" catch for wording
drift, still success-only). deploy-watch's `/latest` is a single snapshot
with no history, so the ring buffer is the only usable deploy record; the
window is therefore "oldest buffered event to now" and the response says
so, because a fixed 30-day window over a 200-event buffer would silently
undercount.

**Change failure rate.** A real (non-drill) blackbox incident whose trigger
fires within 30 minutes after a successful deploy is attributed to that
deploy. Correlation, not causation: an unrelated outage 20 minutes after a
deploy counts, a slow failure 40 minutes later does not. The correlation
window is in the response. With zero deploys in window the rate is `null`
with a note, never a fake 0%.

**MTTR.** Recovery of an incident is the first success-level event after
its trigger that shares a meaningful token with the trigger text
("ramone", "sentinel", a repo name), stopwords removed. Incidents with no
matching recovery event are listed as unmeasured with the reason. The
response reports "n of m measured" so a mean over 2 of 7 incidents cannot
masquerade as a mean over all 7.

**Drill incidents** (`trigger.dialect: "drill"`, the synthetic ground
tests) are excluded from everything and counted in
`drillIncidentsExcluded`.

**Trend.** Each MISS stores the freshly computed metrics under a durable
KV key; the next computation diffs against it and reports direction plus
delta per metric. No previous snapshot means `flat` with `delta: null`,
never a fabricated baseline.

## Degradation

Upstreams are fetched in parallel with individual 5s budgets
(`Promise.allSettled`). One upstream down means partial metrics plus a
`degraded` array naming it; only all three down produces a 503, and errors
are never cached. The panel renders the degraded state as an amber line.

## Deploy

CI (`.github/workflows/ci.yml`) runs ESLint, Vitest, and a wrangler dry
run. It is inline for now; the comment at the top says when and how to swap
it for atlas-infra's reusable `deploy-worker.yml`.

First deploy, from the repo root (also printed by `instructions.sh`):

```
npm ci                 # install the exact versions pinned in package-lock.json
npx wrangler login
npx wrangler kv namespace create DORA_CACHE
# paste the printed id into wrangler.jsonc
npm run check
npx wrangler deploy
```

Then attach the route: uncomment the `routes` block in `wrangler.jsonc`,
fill `zone_id` (never `zone_name`: the scoped token cannot resolve names),
and deploy again.

## Panel

`panel/dora-panel.html` is a standalone page whose marked copy region drops
into the Lab page: scoped styles, site CSS variables with brand fallbacks,
vanilla JS, no framework. Three cards with trend arrows (deploys up is
green; CFR and MTTR up is red), the degraded line, a footer showing the
window basis, compute time, and whether the response was a cache HIT or
MISS, refreshing every 5 minutes to match the cache TTL. Errors render in
the panel in red; there is no silent blank state.

CSP reminder (banked estate lesson): the Lab page's `_headers` must allow
this Worker's origin in `connect-src`, or the panel works in curl and dies
in the browser.

## Deliberately not built

Writing a `dora_summary` event back into atlas-notify was considered and
dropped: posting requires a secret, and this Worker's value is that it
holds none. If the estate ever wants that event, it belongs in a separate
minimal producer, not here.
