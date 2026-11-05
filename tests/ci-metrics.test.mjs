import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const entry = new URL('../.gitea/scripts/ci-metrics.mjs', import.meta.url);
const sourceAvailable = fs.existsSync(entry);
const sourcePolicyAvailable = fs.existsSync(new URL('../.public-export/allowlist.json', import.meta.url));
const metrics = sourceAvailable ? await import(entry.href) : null;

const api = 'https://forge.invalid/api/v1';
const at = (minute) => `2026-11-02T0${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}:00+09:00`;
function run(id, path, event, conclusion, startMinute, length) {
  return {
    id, path, event, status: 'completed', conclusion,
    created_at: at(startMinute), started_at: at(startMinute), completed_at: at(startMinute + length),
  };
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

describe('source CI metrics', () => {
  it('keeps the source-only entry and export policy availability coherent', () => {
    expect(sourceAvailable).toBe(sourcePolicyAvailable);
  });

  if (!sourceAvailable) return;

  it('takes nearest-rank percentiles', () => {
    expect(metrics.percentile([], 0.5)).toBeNull();
    expect(metrics.percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(metrics.percentile([4, 1, 3, 2], 0.9)).toBe(4);
    expect(metrics.pullNumber({ path: 'ci.yml@refs/pull/11/head' })).toBe(11);
    expect(metrics.pullNumber({ path: 'ci.yml@refs/heads/main' })).toBeNull();
  });

  it('summarises runs per workflow and event, per pull request and by Renovate share', () => {
    const runs = [
      run(1, 'ci.yml@refs/pull/11/head', 'pull_request', 'failure', 0, 2),
      run(2, 'ci.yml@refs/pull/11/head', 'pull_request', 'success', 10, 3),
      run(3, 'ci.yml@refs/pull/12/head', 'pull_request', 'cancelled', 20, 1),
      run(4, 'ci.yml@refs/heads/main', 'push', 'success', 30, 4),
    ];
    const report = metrics.summarize(runs, new Map([[11, metrics.RENOVATE_LOGIN], [12, 'maintainer']]));
    expect(report.workflows['ci.yml pull_request']).toEqual({
      runs: 3, conclusions: { failure: 1, success: 1, cancelled: 1 }, p50Minutes: 2, p90Minutes: 3,
    });
    expect(report.workflows['ci.yml push']).toMatchObject({ runs: 1, p50Minutes: 4 });
    expect(report).toMatchObject({ pullRequests: 2, runsPerPullRequest: 1.5, maxRunsOnePullRequest: 2 });
    expect(report.renovateShareOfPullRequestRuns).toBe(0.67);
  });

  it('pages back to the start of the window, keeps each run once and fails closed', async () => {
    const page1 = [run(5, 'ci.yml@refs/heads/main', 'push', 'success', 50, 1), run(4, 'ci.yml@refs/heads/main', 'push', 'success', 40, 1)];
    const page2 = [run(4, 'ci.yml@refs/heads/main', 'push', 'success', 40, 1), run(3, 'ci.yml@refs/heads/main', 'push', 'success', 0, 1)];
    const pages = [page1, page2];
    let calls = 0;
    const fetchImpl = async () => ok({ total_count: 9, workflow_runs: pages[calls++] ?? [] });
    const runs = await metrics.runsSince(api, 't', Date.parse(at(30)), fetchImpl);
    expect(runs.map((item) => item.id)).toEqual([5, 4, 3]);
    expect(calls).toBe(2);
    const short = async () => ok({ total_count: 5, workflow_runs: [] });
    await expect(metrics.runsSince(api, 't', 0, short)).rejects.toThrow(/0 of 5/);
    await expect(metrics.runsSince(api, 't', 0, async () => ok({ workflow_runs: [] }))).rejects.toThrow(/malformed/);
    await expect(metrics.runsSince(api, 't', 0, async () => ({ ok: false, status: 403 }))).rejects.toThrow(/HTTP 403/);
  });

  it('measures a window end to end and validates its arguments', async () => {
    const runs = [
      run(9, 'ci.yml@refs/pull/11/head', 'pull_request', 'failure', 70, 2),
      run(8, 'ci.yml@refs/pull/11/head', 'pull_request', 'success', 5, 2),
    ];
    const fetchImpl = async (url) => {
      if (url.includes('/actions/runs?')) return ok({ total_count: 2, workflow_runs: runs });
      if (url.endsWith('/pulls/11')) return ok({ user: { login: metrics.RENOVATE_LOGIN } });
      if (url.endsWith('/actions/runs/9/jobs')) return ok({ jobs: [{ name: 'Test', conclusion: 'failure' }, { name: 'Lint', conclusion: 'success' }] });
      throw new Error(`unexpected ${url}`);
    };
    let output = '';
    const deps = { fetch: fetchImpl, write: (text) => { output += text; } };
    const env = { GITEA_API_URL: api, GITEA_TOKEN: 'placeholder' };
    await expect(metrics.main(['--since', '2026-11-02', '--until', '2026-11-03', '--jobs'], env, deps)).resolves.toBe(0);
    const report = JSON.parse(output);
    expect(report.totalRuns).toBe(2);
    expect(report.renovateShareOfPullRequestRuns).toBe(1);
    expect(report.failedJobs).toEqual({ 'ci.yml / Test': 1 });
    await expect(metrics.main(['--since', '2026-11-03', '--until', '2026-11-02'], env, deps)).rejects.toThrow(/before/);
    await expect(metrics.main(['--since', '11/02', '--until', '2026-11-03'], env, deps)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(metrics.main(['--sin', '2026-11-02'], env, deps)).rejects.toThrow();
    await expect(metrics.main(['--since', '2026-11-02', '--until', '2026-11-03'], { ...env, GITEA_TOKEN: '' }, deps)).rejects.toThrow(/GITEA_TOKEN/);
  });
});
