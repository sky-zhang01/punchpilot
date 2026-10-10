import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import ScheduleConfigCard from './ScheduleConfigCard';
import MockModeCard from './MockModeCard';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), success: vi.fn(), error: vi.fn() }));
const schedule = (action_type: string, fixed_time: string) => ({ action_type, fixed_time, mode: 'fixed', window_start: fixed_time, window_end: fixed_time, resolved_time: '', enabled: true });
const state = { config: { schedules: [schedule('break_start', '12:00'), schedule('break_end', '13:00')], autoEnabled: true, debugMode: false, holidaySkipCountries: 'jp' } };
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../store/hooks', () => ({ useAppDispatch: () => mocks.dispatch, useAppSelector: (selector: (value: typeof state) => unknown) => selector(state) }));
vi.mock('../../utils/notify', () => ({ notifySuccess: mocks.success, notifyError: mocks.error }));
vi.mock('antd', () => {
  const wrap = ({ children }: any) => <div>{children}</div>;
  const Radio = { Group: wrap, Button: wrap };
  return { Card: wrap, Space: wrap, Row: wrap, Col: wrap, Tag: wrap, Radio,
    Alert: ({ message }: any) => <div>{message}</div>, Select: () => null,
    Typography: { Text: wrap, Title: wrap },
    Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
    Switch: ({ checked, onChange }: any) => <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />,
    TimePicker: ({ value, onChange }: any) => <input aria-label="time" value={value?.format('HH:mm') || ''} onChange={event => onChange(dayjs(`2000-01-01T${event.target.value}:00`))} />,
  };
});

describe('schedule and mode mutation feedback', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.dispatch.mockReturnValue({ unwrap: () => Promise.resolve({}) }); });
  it('checks an edited break against the other saved action, ignoring unsaved edits', () => {
    render(<ScheduleConfigCard />);
    const fields = screen.getAllByLabelText('time');
    fireEvent.change(fields[1], { target: { value: '14:00' } });
    fireEvent.change(fields[0], { target: { value: '12:30' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'common.save' })[0]);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('scheduleCard.breakMinDuration');
  });
  it('rejects a break exceeding 90 minutes', () => {
    render(<ScheduleConfigCard />);
    fireEvent.change(screen.getAllByLabelText('time')[0], { target: { value: '11:00' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'common.save' })[0]);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('scheduleCard.breakMinDuration');
  });
  it('reports a failed save without success feedback', async () => {
    mocks.dispatch.mockReturnValue({ unwrap: () => Promise.reject(new Error('failed')) });
    render(<ScheduleConfigCard />);
    fireEvent.click(screen.getAllByRole('button', { name: 'common.save' })[0]);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('scheduleCard.saveFailed'));
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it('reports a rejected mock-mode toggle without claiming a new mode', async () => {
    mocks.dispatch.mockReturnValue({ unwrap: () => Promise.reject(new Error('failed')) });
    render(<MockModeCard />);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('common.error'));
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
