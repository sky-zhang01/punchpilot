import { describe, expect, it } from 'vitest';
import { timeToMinutes } from '../shared/date-time.js';
import {
  DEFAULT_MAX_BREAK_MINUTES,
  breakWindowsCompatible,
  earliestCompliantCheckoutMinute,
  normalizeWorkRules,
  resolveBreakTimes,
  resolveDailyTimes,
  workRulesFeasible,
} from '../shared/schedule-policy.js';

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = (action_type, start, end, enabled = 1) =>
  ({ action_type, enabled, mode: 'random', fixed_time: start, window_start: start, window_end: end });
const fixed = (action_type, time, enabled = 1) =>
  ({ action_type, enabled, mode: 'fixed', fixed_time: time, window_start: time, window_end: time });

const OWNER = [
  random('checkin', '09:50', '10:00'),
  random('break_start', '12:00', '13:00'),
  random('break_end', '13:00', '14:00'),
  random('checkout', '19:15', '20:30'),
];
const OWNER_LATE_END = OWNER.map((cfg) => (cfg.action_type === 'checkout' ? random('checkout', '19:15', '20:00') : cfg));
const DEFAULT = [
  random('checkin', '09:50', '10:00'),
  random('checkout', '19:00', '20:00'),
  random('break_start', '12:00', '12:30'),
  random('break_end', '13:00', '13:30'),
];
const RULES = { minNetWorkMinutes: 480, maxBreakMinutes: 75 };
const inWindow = (time, cfg) => {
  const minutes = timeToMinutes(time);
  return minutes >= timeToMinutes(cfg.window_start) && minutes <= timeToMinutes(cfg.window_end);
};
const byAction = (configs, action) => configs.find((cfg) => cfg.action_type === action);

describe('resolveDailyTimes over many seeded draws', () => {
  for (const [name, configs, rules] of [
    ['owner configuration', OWNER, RULES],
    ['owner configuration with a 20:00 checkout end', OWNER_LATE_END, RULES],
    ['default configuration', DEFAULT, RULES],
    ['default configuration with a 90 minute cap', DEFAULT, { minNetWorkMinutes: 480, maxBreakMinutes: 90 }],
  ]) {
    it(`keeps windows, break length, checkout end and net work: ${name}`, () => {
      expect(workRulesFeasible(configs, rules)).toBe(true);
      const draw = seeded(20261031);
      for (let i = 0; i < 4000; i += 1) {
        const { times, breakPair } = resolveDailyTimes(configs, {}, rules, draw);
        expect(breakPair).toBeTruthy();
        for (const action of ['checkin', 'break_start', 'break_end', 'checkout']) {
          expect(inWindow(times[action], byAction(configs, action)), `${action} ${times[action]}`).toBe(true);
        }
        const breakMinutes = timeToMinutes(times.break_end) - timeToMinutes(times.break_start);
        expect(breakMinutes).toBeGreaterThanOrEqual(60);
        expect(breakMinutes).toBeLessThanOrEqual(rules.maxBreakMinutes);
        const net = timeToMinutes(times.checkout) - timeToMinutes(times.checkin) - breakMinutes;
        expect(net).toBeGreaterThanOrEqual(rules.minNetWorkMinutes);
      }
    });
  }

  it('never plans the 2026-10-29 shape: 79 minute break with a 19:16 checkout after a 09:59 checkin', () => {
    const draw = seeded(7);
    for (let i = 0; i < 4000; i += 1) {
      const { times } = resolveDailyTimes(OWNER_LATE_END, {}, RULES, draw);
      const net = timeToMinutes(times.checkout) - timeToMinutes(times.checkin)
        - (timeToMinutes(times.break_end) - timeToMinutes(times.break_start));
      expect(net).toBeGreaterThanOrEqual(480);
    }
  });

  it('prefers shorter breaks near the latest checkout, but still varies the break', () => {
    const breaks = new Set();
    const draw = seeded(11);
    for (let i = 0; i < 2000; i += 1) {
      const { times } = resolveDailyTimes(OWNER_LATE_END, {}, RULES, draw);
      breaks.add(timeToMinutes(times.break_end) - timeToMinutes(times.break_start));
    }
    expect(Math.min(...breaks)).toBe(60);
    expect(Math.max(...breaks)).toBeLessThanOrEqual(75);
    expect(breaks.size).toBeGreaterThan(5);
  });

  it('gives net work priority and caps at 23:59 when the windows cannot satisfy the rule', () => {
    const infeasible = [random('checkin', '09:00', '10:00'), random('checkout', '17:00', '17:30')];
    expect(workRulesFeasible(infeasible, RULES)).toBe(false);
    const draw = seeded(3);
    for (let i = 0; i < 500; i += 1) {
      const { times } = resolveDailyTimes(infeasible, {}, RULES, draw);
      const needed = timeToMinutes(times.checkin) + 480;
      expect(timeToMinutes(times.checkout)).toBeGreaterThanOrEqual(needed);
      // Past the window end only when net work forces it.
      if (needed > timeToMinutes('17:30')) expect(timeToMinutes(times.checkout)).toBe(needed);
      else expect(timeToMinutes(times.checkout)).toBeLessThanOrEqual(timeToMinutes('17:30'));
    }
    const late = [fixed('checkin', '20:00'), fixed('checkout', '21:00')];
    expect(resolveDailyTimes(late, {}, RULES).times.checkout).toBe('23:59');
  });

  it('keeps stored times immutable and derives only the missing ones from them', () => {
    const draw = seeded(5);
    for (let i = 0; i < 500; i += 1) {
      const { times, breakPair } = resolveDailyTimes(OWNER_LATE_END, { checkin: '09:59', break_start: '12:33', break_end: '13:52' }, RULES, draw);
      expect(times).toMatchObject({ checkin: '09:59', break_start: '12:33', break_end: '13:52' });
      // The stored 79 minute pair is longer than the 75 minute cap but stays the day's plan.
      expect(breakPair).toEqual({ start: '12:33', end: '13:52' });
      // 09:59 + 79 minutes + 480 minutes = 19:18
      expect(timeToMinutes(times.checkout)).toBeGreaterThanOrEqual(timeToMinutes('19:18'));
    }
    const stored = resolveDailyTimes(OWNER, { checkout: '17:00', checkin: '09:00' }, RULES, seeded(1));
    expect(stored.times).toMatchObject({ checkin: '09:00', checkout: '17:00' });
    const startOnly = resolveDailyTimes(OWNER, { break_start: '12:50' }, RULES, seeded(2));
    expect(startOnly.times.break_start).toBe('12:50');
    expect(timeToMinutes(startOnly.times.break_end) - 770).toBeLessThanOrEqual(75);
  });

  it('keeps a stored pair drawn under the old 90 minute cap after the cap is lowered', () => {
    const { times, breakPair } = resolveDailyTimes(DEFAULT, { checkin: '10:00', break_start: '12:05', break_end: '13:35' }, RULES, seeded(3));
    expect(breakPair).toEqual({ start: '12:05', end: '13:35' });
    expect(times).toMatchObject({ break_start: '12:05', break_end: '13:35' });
    // 10:00 + 90 minutes + 480 minutes = 19:30, inside the 19:00-20:00 window.
    expect(timeToMinutes(times.checkout)).toBeGreaterThanOrEqual(timeToMinutes('19:30'));
    expect(timeToMinutes(times.checkout)).toBeLessThanOrEqual(timeToMinutes('20:00'));
  });

  it('does not treat a stored pair no cap could produce as a plan', () => {
    for (const pair of [{ break_start: '14:00', break_end: '12:00' }, { break_start: '12:00', break_end: '12:30' },
      { break_start: '10:00', break_end: '14:00' }]) {
      const { times, breakPair } = resolveDailyTimes(OWNER, pair, RULES, seeded(6));
      expect(breakPair).toBeNull();
      expect(times).toMatchObject(pair);
    }
  });

  it('derives check-out without a break when the break punches are paused', () => {
    const configs = [fixed('checkin', '10:00'), fixed('break_start', '12:00'), fixed('break_end', '14:30'),
      random('checkout', '18:00', '20:00')];
    for (let i = 0; i < 200; i += 1) {
      const { times, breakPair } = resolveDailyTimes(configs, {}, RULES, seeded(i));
      expect(breakPair).toBeNull();
      // 10:00 + 480 minutes; the 150 minute placeholder is never punched.
      expect(timeToMinutes(times.checkout)).toBeGreaterThanOrEqual(timeToMinutes('18:00'));
      expect(timeToMinutes(times.checkout)).toBeLessThanOrEqual(timeToMinutes('20:00'));
    }
  });

  it('finds an end for a start stored under the old cap that the new cap cannot reach', () => {
    // break_end window 13:30-13:45 with a stored 12:15 start: 75 minutes ends at 13:30 at the latest
    // and 90 minutes at 13:45, so only the old cap leaves a choice when 13:30 alone is too early.
    const configs = [random('checkin', '09:50', '10:00'), random('break_start', '12:00', '12:30'),
      random('break_end', '13:31', '13:45'), random('checkout', '19:00', '20:30')];
    const { times, breakPair } = resolveDailyTimes(configs, { break_start: '12:15' }, RULES, seeded(4));
    expect(breakPair).not.toBeNull();
    expect(times.break_start).toBe('12:15');
    expect(timeToMinutes(times.break_end)).toBeGreaterThanOrEqual(timeToMinutes('13:31'));
    expect(timeToMinutes(times.break_end) - timeToMinutes('12:15')).toBeLessThanOrEqual(90);
  });

  it('returns times only for enabled actions', () => {
    const configs = [random('checkin', '09:00', '09:30'), random('checkout', '18:00', '19:00', 0),
      random('break_start', '12:00', '12:30', 0), random('break_end', '13:00', '13:30', 0)];
    const { times, breakPair } = resolveDailyTimes(configs, {}, RULES, seeded(9));
    expect(Object.keys(times)).toEqual(['checkin']);
    expect(breakPair).toBeUndefined();
  });

  it('draws a lone break action on its own and flags incompatible windows', () => {
    const lone = [random('break_start', '12:00', '12:30'), random('break_end', '13:00', '13:30', 0)];
    expect(Object.keys(resolveDailyTimes(lone, {}, RULES, seeded(1)).times)).toEqual(['break_start']);
    const bad = [fixed('break_start', '12:00'), fixed('break_end', '14:00')];
    const result = resolveDailyTimes(bad, {}, RULES, seeded(1));
    expect(result.breakPair).toBeNull();
    expect(result.times).toMatchObject({ break_start: '12:00', break_end: '14:00' });
  });

  it('plans checkout from the window alone when the rule is off or there is no checkin', () => {
    const off = resolveDailyTimes(DEFAULT, {}, { minNetWorkMinutes: 0, maxBreakMinutes: 75 }, () => 0);
    expect(off.times.checkout).toBe('19:00');
    const noCheckin = DEFAULT.map((cfg) => (cfg.action_type === 'checkin' ? { ...cfg, enabled: 0 } : cfg));
    expect(resolveDailyTimes(noCheckin, {}, RULES, () => 0).times.checkout).toBe('19:00');
  });
});

describe('resolveBreakTimes cap parameters', () => {
  const start = random('break_start', '12:00', '13:00');
  const end = random('break_end', '13:00', '14:00');
  it('respects the configured maximum and the extra duration cap', () => {
    const draw = seeded(4);
    for (let i = 0; i < 1000; i += 1) {
      const pair = resolveBreakTimes(start, end, {}, draw, 70, 65);
      const length = timeToMinutes(pair.end) - timeToMinutes(pair.start);
      expect(length).toBeGreaterThanOrEqual(60);
      expect(length).toBeLessThanOrEqual(65);
    }
    expect(resolveBreakTimes(fixed('break_start', '12:00'), fixed('break_end', '13:20'), {}, () => 0, 75)).toBeNull();
    expect(resolveBreakTimes(fixed('break_start', '12:00'), fixed('break_end', '13:20'), {}, () => 0, 90)).toEqual({ start: '12:00', end: '13:20' });
    expect(DEFAULT_MAX_BREAK_MINUTES).toBe(75);
  });
});

describe('feasibility and compatibility', () => {
  it('accepts the owner and default configurations', () => {
    expect(workRulesFeasible(OWNER, RULES)).toBe(true);
    expect(workRulesFeasible(DEFAULT, RULES)).toBe(true);
    expect(breakWindowsCompatible(OWNER, 75)).toBe(true);
  });
  it('is trivially feasible when the rule is off or checkin, checkout are disabled', () => {
    const short = [random('checkin', '09:00', '10:00'), random('checkout', '12:00', '13:00')];
    expect(workRulesFeasible(short, RULES)).toBe(false);
    expect(workRulesFeasible(short, { ...RULES, minNetWorkMinutes: 0 })).toBe(true);
    expect(workRulesFeasible(short.map((cfg) => ({ ...cfg, enabled: 0 })), RULES)).toBe(true);
  });
  it('counts the shortest feasible break, and a fixed checkout end as a one-minute window', () => {
    const configs = [fixed('checkin', '10:00'), fixed('checkout', '19:00'), fixed('break_start', '12:00'), fixed('break_end', '13:00')];
    expect(workRulesFeasible(configs, RULES)).toBe(true);
    const longer = configs.map((cfg) => (cfg.action_type === 'break_end' ? fixed('break_end', '13:30') : cfg));
    expect(workRulesFeasible(longer, { minNetWorkMinutes: 480, maxBreakMinutes: 90 })).toBe(false);
    expect(workRulesFeasible(longer, { minNetWorkMinutes: 450, maxBreakMinutes: 90 })).toBe(true);
  });
  it('treats breaks that are off as no break time', () => {
    const configs = [fixed('checkin', '10:00'), fixed('checkout', '18:00'), fixed('break_start', '12:00', 0), fixed('break_end', '13:00', 0)];
    expect(workRulesFeasible(configs, RULES)).toBe(true);
  });
  it('rejects break windows beyond the maximum', () => {
    const wide = [fixed('break_start', '12:00'), fixed('break_end', '13:30')];
    expect(breakWindowsCompatible(wide, 75)).toBe(false);
    expect(breakWindowsCompatible(wide, 90)).toBe(true);
    expect(breakWindowsCompatible([fixed('break_start', '12:00', 0), fixed('break_end', '15:00')], 75)).toBe(true);
  });
  it('normalizes stored settings and falls back to defaults for invalid ones', () => {
    expect(normalizeWorkRules('450', '90')).toEqual({ minNetWorkMinutes: 450, maxBreakMinutes: 90 });
    expect(normalizeWorkRules('0', '75').minNetWorkMinutes).toBe(0);
    expect(normalizeWorkRules(null, 'abc')).toEqual({ minNetWorkMinutes: 480, maxBreakMinutes: 75 });
    expect(normalizeWorkRules('30', '30')).toEqual({ minNetWorkMinutes: 480, maxBreakMinutes: 75 });
    expect(normalizeWorkRules('961', '181')).toEqual({ minNetWorkMinutes: 480, maxBreakMinutes: 75 });
  });
});

describe('earliestCompliantCheckoutMinute', () => {
  const at = (hhmm) => timeToMinutes(hhmm);
  it('adds the minimum to checkin plus one completed break', () => {
    expect(earliestCompliantCheckoutMinute([
      { type: 'checkin', time: '09:59' }, { type: 'break_start', time: '12:33' }, { type: 'break_end', time: '13:52' },
    ], 480)).toBe(at('19:18'));
  });
  it('sums several breaks', () => {
    expect(earliestCompliantCheckoutMinute([
      { type: 'checkin', time: '09:00' }, { type: 'break_start', time: '11:00' }, { type: 'break_end', time: '11:15' },
      { type: 'break_start', time: '12:00' }, { type: 'break_end', time: '13:00' },
    ], 480)).toBe(at('18:15'));
  });
  it('counts net work from segments closed before a re-checkin', () => {
    const reCheckin = [
      { type: 'checkin', time: '08:00' }, { type: 'break_start', time: '10:00' }, { type: 'break_end', time: '11:00' },
      { type: 'checkout', time: '12:00' }, { type: 'checkin', time: '13:00' },
    ];
    // 08:00-12:00 minus the 60-minute break is 180 minutes already worked.
    expect(earliestCompliantCheckoutMinute(reCheckin, 480)).toBe(at('18:00'));
    expect(earliestCompliantCheckoutMinute(reCheckin, 120)).toBe(at('13:00'));
    expect(earliestCompliantCheckoutMinute([
      ...reCheckin, { type: 'break_start', time: '15:00' }, { type: 'break_end', time: '15:30' },
    ], 480)).toBe(at('18:30'));
  });
  it('returns null for an open break, no checkin, a closing checkout or the rule off', () => {
    expect(earliestCompliantCheckoutMinute([{ type: 'checkin', time: '09:00' }, { type: 'break_start', time: '12:00' }], 480)).toBeNull();
    expect(earliestCompliantCheckoutMinute([], 480)).toBeNull();
    expect(earliestCompliantCheckoutMinute([{ type: 'break_start', time: '12:00' }, { type: 'break_end', time: '13:00' }], 480)).toBeNull();
    expect(earliestCompliantCheckoutMinute([{ type: 'checkin', time: '09:00' }, { type: 'checkout', time: '17:00' }], 480)).toBeNull();
    expect(earliestCompliantCheckoutMinute([{ type: 'checkin', time: '09:00' }], 0)).toBeNull();
  });
  it('caps at 23:59', () => {
    expect(earliestCompliantCheckoutMinute([{ type: 'checkin', time: '20:00' }], 600)).toBe(at('23:59'));
  });
});
