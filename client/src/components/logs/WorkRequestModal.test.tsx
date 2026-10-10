import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkRequestModal from './WorkRequestModal';
import { TaskError, type TaskDTO } from '../../tasks';

const mocks = vi.hoisted(() => ({ submitBatchLeaveRequest: vi.fn(), success: vi.fn(), error: vi.fn() }));
const state = { config: { schedules: [] } };
vi.mock('../../store/hooks', () => ({ useAppSelector: (select: any) => select(state) }));
vi.mock('../../api', () => ({ default: { submitBatchLeaveRequest: mocks.submitBatchLeaveRequest } }));
vi.mock('../../utils/notify', () => ({ notifySuccess: mocks.success, notifyError: mocks.error }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: unknown) => `${key}${values ? JSON.stringify(values) : ''}` }) }));
vi.mock('antd', () => {
  const wrap = ({ children }: any) => <div>{children}</div>;
  return { Space: wrap, Tag: wrap, Typography: { Text: wrap }, Select: () => null, DatePicker: () => null, TimePicker: () => null, Switch: () => null,
    Input: { TextArea: () => null },
    Alert: ({ message, description }: any) => <div>{message}{description}</div>,
    Modal: ({ children, onOk, okButtonProps }: any) => <div>{children}<button onClick={onOk} disabled={okButtonProps.disabled}>submit</button></div>,
  };
});
const task: TaskDTO = { taskId: 'work-task', taskType: 'batch_leave', status: 'completed', success: false, partial: false, total: 2, processed: 2, succeeded: 1, failed: 0, unknown: 1, results: [{ date: '2026-10-01', success: true }, { date: '2026-10-02', success: false, unknown: true }], createdAt: null, completedAt: null, strategy_info: null, error: null, code: null };
describe('work request outcome display', () => {
  beforeEach(() => vi.clearAllMocks());
  it('keeps unknown results visible and prevents resubmission as success', async () => {
    mocks.submitBatchLeaveRequest.mockResolvedValue({ data: task });
    const close = vi.fn();
    render(<WorkRequestModal open onClose={close} preSelectedDates={['2026-10-01', '2026-10-02']} />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await screen.findByText(/tasks.counts.*"unknown":1/);
    expect(close).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled();
  });
  it('blocks re-submission when admission has no recoverable task id', async () => {
    mocks.submitBatchLeaveRequest.mockRejectedValue({ code: 'TASK_ADMISSION_UNKNOWN' });
    render(<WorkRequestModal open onClose={vi.fn()} preSelectedDates={['2026-10-01', '2026-10-02']} />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await screen.findByText('tasks.admissionUnknown');
    expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled();
    expect(mocks.submitBatchLeaveRequest).toHaveBeenCalledTimes(1);
  });
  it('preserves the partial checkpoint after a network interruption', async () => {
    mocks.submitBatchLeaveRequest.mockRejectedValue(new TaskError('offline', task.taskId, { ...task, status: 'running', partial: true, processed: 1, unknown: 0, results: task.results.slice(0, 1) }, 'TASK_QUERY_FAILED'));
    render(<WorkRequestModal open onClose={vi.fn()} preSelectedDates={['2026-10-01', '2026-10-02']} />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await screen.findByText(/tasks.counts.*"unprocessed":1/);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('tasks.queryPaused'));
    expect(screen.getByRole('button', { name: 'submit' })).toBeDisabled();
    expect(mocks.submitBatchLeaveRequest).toHaveBeenCalledTimes(1);
  });
});
