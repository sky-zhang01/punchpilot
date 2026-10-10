import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskRecoveryPanel from './TaskRecoveryPanel';
import { clearTaskReferences } from '../../tasks';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}` }) }));
vi.mock('antd', () => ({
  Alert: ({ message, description }: any) => <div role="status">{message}{description}</div>,
  Button: ({ children, onClick, disabled, loading }: any) => <button disabled={disabled || loading} onClick={onClick}>{children}</button>,
  Card: ({ children, title }: any) => <section>{title}{children}</section>,
  Space: ({ children }: any) => <div>{children}</div>,
  Tag: ({ children }: any) => <span>{children}</span>,
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
}));

describe('task recovery display', () => {
  beforeEach(() => { clearTaskReferences(); vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => vi.unstubAllGlobals());
  it('restores references through GET and shows unknown separately from unprocessed', async () => {
    sessionStorage.setItem('punchpilot.tasks', JSON.stringify([{ taskId: 'saved-task', taskType: 'batch_leave' }]));
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ taskId: 'saved-task', taskType: 'batch_leave', status: 'interrupted', createdAt: null, completedAt: null, total: 3, processed: 2, succeeded: 1, failed: 0, unknown: 1, partial: true, success: false, results: [{ date: '2026-10-01', success: true }, { date: '2026-10-02', success: false, unknown: true }], strategy_info: null, error: 'Interrupted', code: 'TASK_OUTCOME_UNKNOWN' })));
    render(<TaskRecoveryPanel />);
    await screen.findByText(/tasks.counts.*"unknown":1.*"unprocessed":1/);
    expect(screen.getByText('2026-10-02')).toBeTruthy();
    expect(screen.getByText('tasks.verifyUnknown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'tasks.resume' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });
});
