/**
 * Pure-function tests over metrics.js. Fixtures are trimmed copies of live
 * responses captured 2026-07-13, so a passing suite means the heuristics
 * hold against the estate's real shapes, not idealised ones.
 */

import { describe, expect, it } from 'vitest';
import {
  changeFailureRate,
  computeMetrics,
  computeWindow,
  deployRepo,
  isDeployEvent,
  isDrillIncident,
  meanTimeToRecovery,
  parseTs,
  trendAgainst,
} from '../src/metrics.js';

const T0 = Date.parse('2026-07-10T10:00:00.000Z');
const NOW = Date.parse('2026-07-13T00:00:00.000Z');

const iso = (offsetMinutes) => new Date(T0 + offsetMinutes * 60000).toISOString();

const deploy = (offsetMinutes, repo = 'atlas-notify') => ({
  ts: iso(offsetMinutes),
  level: 'success',
  dialect: 'envelope',
  event: 'alert',
  title: `Deployed: ${repo}`,
  message: 'Deployed to production [6c79014]',
});

const incident = (offsetMinutes, { dialect = 'envelope', title = 'Ramone unreachable', event = 'alert' } = {}) => ({
  id: `inc-${offsetMinutes}`,
  ts: T0 + offsetMinutes * 60000, // epoch ms, as the live list uses
  sealed: true,
  trigger: {
    ts: iso(offsetMinutes), // ISO Z, as the live trigger uses
    level: 'failure',
    dialect,
    event,
    title,
    message: 'ramone.atlas-systems.uk has been unreachable for 15+ minutes',
  },
});

describe('parseTs', () => {
  it('handles both live dialects and rejects junk', () => {
    expect(parseTs('2026-07-10T11:08:30.808Z')).toBe(Date.parse('2026-07-10T11:08:30.808Z'));
    expect(parseTs(1783681741498)).toBe(1783681741498);
    expect(parseTs('not a date')).toBeNull();
    expect(parseTs(null)).toBeNull();
  });
});

describe('deploy detection', () => {
  it('matches the confirmed live convention and extracts the repo', () => {
    const event = deploy(0, 'atlas-notify');
    expect(isDeployEvent(event)).toBe(true);
    expect(deployRepo(event)).toBe('atlas-notify');
  });

  it('never counts failures or blocks as deploys', () => {
    expect(isDeployEvent({ level: 'failure', title: 'Blocked: atlas-systems.uk' })).toBe(false);
    expect(isDeployEvent({ level: 'failure', title: 'Deployed: x' })).toBe(false);
  });

  it('catches deploy wording drift only at success level', () => {
    expect(isDeployEvent({ level: 'success', title: 'deploy finished', event: 'ci' })).toBe(true);
    expect(isDeployEvent({ level: 'info', title: 'deploy queued' })).toBe(false);
  });
});

describe('changeFailureRate', () => {
  it('attributes an incident within 30 minutes after a deploy', () => {
    const deploys = [deploy(0), deploy(120)];
    const incidents = [incident(20)]; // 20 min after the first deploy
    const result = changeFailureRate(deploys, incidents);
    expect(result.failedDeploys).toBe(1);
    expect(result.totalDeploys).toBe(2);
    expect(result.rate).toBe(0.5);
  });

  it('ignores incidents before a deploy or outside the window', () => {
    const deploys = [deploy(60)];
    const incidents = [incident(10), incident(120)]; // before; 60 min after
    expect(changeFailureRate(deploys, incidents).failedDeploys).toBe(0);
  });

  it('excludes drill incidents entirely', () => {
    const deploys = [deploy(0)];
    const incidents = [incident(10, { dialect: 'drill', title: 'ground test', event: 'test-incident' })];
    expect(isDrillIncident(incidents[0])).toBe(true);
    expect(changeFailureRate(deploys, incidents).failedDeploys).toBe(0);
  });

  it('reports null, not zero, when there are no deploys', () => {
    const result = changeFailureRate([], [incident(10)]);
    expect(result.rate).toBeNull();
    expect(result.note).toContain('no deploys');
  });
});

describe('meanTimeToRecovery', () => {
  it('measures trigger to the first token-matching success', () => {
    const events = [
      { ts: iso(45), level: 'success', event: 'ramone', title: 'ramone: awake', message: '' },
      { ts: iso(50), level: 'success', event: 'alert', title: 'Deployed: atlas-vault', message: '' },
    ];
    const incidents = [incident(15, { title: 'Ramone unreachable', event: 'alert' })];
    const result = meanTimeToRecovery(events, incidents);
    expect(result.measuredIncidents).toBe(1);
    expect(result.meanMinutes).toBe(30);
  });

  it('reports unmeasured with a reason instead of guessing', () => {
    const events = [{ ts: iso(45), level: 'success', event: 'alert', title: 'Deployed: atlas-vault', message: '' }];
    const incidents = [incident(15, { title: 'Infra health: sentinel silent', event: 'infra_health' })];
    const result = meanTimeToRecovery(events, incidents);
    expect(result.measuredIncidents).toBe(0);
    expect(result.meanMinutes).toBeNull();
    expect(result.unmeasured[0].reason).toContain('no matching success event');
  });
});

describe('computeWindow', () => {
  it('spans the oldest event to now and reports its basis', () => {
    const events = [deploy(0), deploy(60)];
    const window = computeWindow(events, NOW);
    expect(window.fromMs).toBe(T0);
    expect(window.toMs).toBe(NOW);
  });

  it('is null with no parseable timestamps', () => {
    expect(computeWindow([{ ts: 'junk' }], NOW)).toBeNull();
  });
});

describe('trendAgainst', () => {
  it('directions and deltas per metric, flat with null when no baseline', () => {
    const previous = {
      deploymentFrequency: { perWeek: 3 },
      changeFailureRate: { rate: 0.5 },
      mttr: { meanMinutes: 40 },
    };
    const current = {
      deploymentFrequency: { perWeek: 5 },
      changeFailureRate: { rate: 0.25 },
      mttr: { meanMinutes: null },
    };
    const trend = trendAgainst(previous, current);
    expect(trend.deploymentFrequencyPerWeek).toEqual({ dir: 'up', delta: 2 });
    expect(trend.changeFailureRate).toEqual({ dir: 'down', delta: -0.25 });
    expect(trend.mttrMinutes).toEqual({ dir: 'flat', delta: null });
    expect(trendAgainst(null, current).changeFailureRate.delta).toBeNull();
  });
});

describe('computeMetrics end to end', () => {
  it('assembles the full body and counts drill exclusions', () => {
    const events = [
      deploy(0, 'atlas-notify'),
      deploy(300, 'atlas-vault'),
      { ts: iso(45), level: 'success', event: 'ramone', title: 'ramone: awake', message: '' },
    ];
    const incidents = [
      incident(15),
      incident(200, { dialect: 'drill', title: 'ground test', event: 'test-incident' }),
    ];
    const body = computeMetrics({ events, incidents, latestDeploy: { status: 'success' }, nowMs: NOW });
    expect(body.deploymentFrequency.totalInWindow).toBe(2);
    expect(body.deploymentFrequency.byRepo['atlas-notify']).toBe(1);
    expect(body.drillIncidentsExcluded).toBe(1);
    expect(body.changeFailureRate.totalDeploys).toBe(2);
    expect(body.mttr.measuredIncidents).toBe(1);
    expect(body.window.basis).toContain('ring-buffer');
    expect(body.latestDeploy.status).toBe('success');
  });
});
