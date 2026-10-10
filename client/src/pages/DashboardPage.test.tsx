import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';
import { statusFixture } from '../test-fixtures';

const state = { identity: 0, config: { autoEnabled: true, debugMode: true, connectionMode: 'api', oauthConfigured: false }, status: { loading: false, data: statusFixture({
  timezone: 'Asia/Tokyo', startup_analysis: { state: 'unknown', reason: 'Not checked' }, next_action: null,
  today_schedule_status: [{ date: '2026-10-04', resolved_time: '02:30', executed: 0, attempts: 0, action_type: 'checkin', last_status: 'paused_configuration', last_error: 'SCHEDULE_TIME_NONEXISTENT' }],
  today_logs: [{ id: 1, scheduled_time: null, business_date: '2026-10-05', trigger_type: 'scheduled', company_id: null, company_name: null, error_message: null, error_code: null, failure_stage: null, screenshot_before: null, screenshot_after: null, executed_at: '2026-10-04T15:30:00Z', action_type: 'checkin', status: 'skipped', duration_ms: 0 }],
}) } };
const dispatch = vi.fn();
vi.mock('../store/hooks', () => ({ useAppDispatch: () => dispatch, useAppSelector: (select: any) => select(state) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../components/dashboard/ManualTrigger', () => ({ default: () => null }));
vi.mock('antd', () => {
  const wrap = ({ children }: any) => <div>{children}</div>;
  return { Card: wrap, Space: wrap, Row: wrap, Col: wrap, Tag: wrap, Button: wrap, Spin: () => null, Steps: () => null,
    Typography: { Text: wrap, Title: wrap }, Alert: ({ message, description }: any) => <div>{message}{description}</div>,
    Table: ({ columns, dataSource }: any) => <div>{dataSource.map((row: any, i: number) => <div key={i}>{columns.map((col: any) => <div key={col.key}>{col.render(row[col.dataIndex])}</div>)}</div>)}</div>,
  };
});
describe('dashboard schedule state and log units', () => {
  it('shows a paused configuration instead of reporting every action completed', () => {
    render(<DashboardPage />);
    expect(screen.getByText('dashboard.schedulePaused')).toBeTruthy();
    expect(screen.getByText(/dashboard.scheduleTimeNonexistent/)).toBeTruthy();
    expect(screen.queryByText('dashboard.allDone')).toBeNull();
    expect(screen.getByText('00:30:00')).toBeTruthy();
    expect(screen.getByText('0ms')).toBeTruthy();
  });
  it('shows the authoritative current state even when startup analysis is stale', () => {
    state.status.data.attendance_state = 'checked_out';
    state.status.data.startup_analysis = { state: 'not_checked_in', reason: 'Startup snapshot' };
    render(<DashboardPage />);
    expect(screen.getByText('manualTrigger.stateCheckedOut')).toBeTruthy();
    expect(screen.queryByText('manualTrigger.stateNotCheckedIn')).toBeNull();
  });

});
