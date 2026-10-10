import { describe, expect, it } from 'vitest';
import { statusFixture } from '../test-fixtures';
import reducer, { fetchStatus } from './statusSlice';

describe('status request ownership', () => {
  it('does not let an older request replace a newer status or stop its loading flag', () => {
    let state = reducer(undefined, fetchStatus.pending('old', undefined));
    state = reducer(state, fetchStatus.pending('new', undefined));
    state = reducer(state, fetchStatus.fulfilled(statusFixture({ current_date: '2026-10-03' }), 'old', undefined));
    expect(state.data).toBeNull();
    expect(state.loading).toBe(true);
    state = reducer(state, fetchStatus.fulfilled(statusFixture({ current_date: '2026-10-04' }), 'new', undefined));
    expect(state.data).toEqual(statusFixture({ current_date: '2026-10-04' }));
  });
  it('clears cached identity and rejects a late response after an account change', () => {
    let state = reducer(undefined, fetchStatus.pending('old', undefined));
    state = reducer(state, { type: 'account/identityChanged' });
    state = reducer(state, fetchStatus.fulfilled(statusFixture({ current_date: '2026-10-03' }), 'old', undefined));
    expect(state.data).toBeNull();
  });
});
