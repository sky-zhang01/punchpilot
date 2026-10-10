import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import BatchPunchModal from './BatchPunchModal';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), success: vi.fn(), error: vi.fn() }));
const saved = (checkin: string) => ['checkin', 'checkout', 'break_start', 'break_end'].map((action_type, i) => ({ action_type, mode: 'fixed', fixed_time: [checkin, '18:00', '12:00', '13:00'][i], window_start: [checkin, '18:00', '12:00', '13:00'][i], window_end: ['09:30', '19:00', '12:30', '13:30'][i] }));
const state = { config: { schedules: [] as ReturnType<typeof saved> }, attendance: { selectedDates: ['2026-10-01'], records: {}, capabilities: null, batchPunchLoading: false, batchPunchResults: [], batchTask: null } };
vi.mock('../../store/hooks', () => ({ useAppDispatch: () => mocks.dispatch, useAppSelector: (select: any) => select(state) }));
vi.mock('../../store/attendanceSlice', () => ({ batchSubmit: (payload: any) => payload, clearBatchResults: () => ({}) }));
vi.mock('../../utils/notify', () => ({ notifySuccess: mocks.success, notifyError: mocks.error }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('antd', () => {
  const wrap = ({ children }: any) => <div>{children}</div>;
  return { Space: wrap, Tag: wrap, Typography: { Text: wrap }, Divider: () => null, Switch: () => null,
    Radio: { Group: wrap, Button: wrap }, Input: { TextArea: () => null }, Button: wrap,
    Alert: ({ message, description }: any) => <div>{message}{description}</div>,
    Modal: ({ children, open, onOk, okButtonProps }: any) => open ? <div>{children}<button onClick={onOk} disabled={okButtonProps?.disabled}>submit</button></div> : null,
    TimePicker: ({ value, onChange }: any) => <input aria-label="time" value={value?.isValid() ? value.format('HH:mm') : ''} onChange={event => onChange(dayjs(`2000-01-01T${event.target.value}:00`))} />,
  };
});
describe('batch punch saved schedule initialization', () => {
  beforeEach(() => { vi.clearAllMocks(); state.config.schedules = []; });
  it('waits for saved schedules, preserves editing, and reads fresh settings on reopening', async () => {
    const view = render(<BatchPunchModal open onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled();
    state.config.schedules = saved('09:00');
    view.rerender(<BatchPunchModal open onClose={vi.fn()} />);
    await waitFor(() => expect((screen.getAllByLabelText('time')[0] as HTMLInputElement).value).toBe('09:00'));
    fireEvent.change(screen.getAllByLabelText('time')[0], { target: { value: '08:30' } });
    state.config.schedules = saved('09:15');
    view.rerender(<BatchPunchModal open onClose={vi.fn()} />);
    expect((screen.getAllByLabelText('time')[0] as HTMLInputElement).value).toBe('08:30');
    view.rerender(<BatchPunchModal open={false} onClose={vi.fn()} />);
    view.rerender(<BatchPunchModal open onClose={vi.fn()} />);
    expect((screen.getAllByLabelText('time')[0] as HTMLInputElement).value).toBe('09:15');
  });
  it('blocks re-submission when the accepted task id was not received', async () => {
    state.config.schedules = saved('09:00');
    mocks.dispatch.mockReturnValue({ unwrap: () => Promise.reject({ code: 'TASK_ADMISSION_UNKNOWN' }) });
    render(<BatchPunchModal open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await screen.findByText('tasks.admissionUnknown');
    expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
  it('sends the saved local clock values without inventing a UTC offset', async () => {
    state.config.schedules = saved('09:00');
    mocks.dispatch.mockReturnValue({ unwrap: () => Promise.resolve({ results: [{ success: true }], task: { success: true, failed: 0 } }) });
    render(<BatchPunchModal open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({ entries: [{ date: '2026-10-01', clock_in_at: '09:00', clock_out_at: '18:00', is_editable: true, break_records: [{ clock_in_at: '12:00', clock_out_at: '13:00' }] }], reason: undefined }));
  });
});
