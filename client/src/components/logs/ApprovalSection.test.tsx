import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalSection from './ApprovalSection';

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const apiMocks = vi.hoisted(() => ({
  getApprovalRequests: vi.fn(),
  getIncomingRequests: vi.fn(),
  batchApproveRequests: vi.fn(),
}));

const notifyMocks = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));

const approvalContext = {
  current_round: 0,
  current_step_id: 2468,
  request_version: `v1.${'a'.repeat(43)}`,
};

const state = {
  attendance: {
    year: 2026,
    month: 5,
    capabilities: null as null | { approval: boolean },
  },
  config: {
    freeeConfigured: false,
    webCredentialsConfigured: false,
    oauthConfigured: false,
  },
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd', () => {
  return {
    Alert: ({ message }: any) => <div role="alert">{message}</div>,
    Button: ({ children, disabled, onClick }: any) => (
      <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
    ),
    Checkbox: ({ checked, disabled, onChange }: any) => (
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
    ),
    Modal: ({ children, open }: any) => open ? <div role="dialog">{children}</div> : null,
    Popconfirm: ({ children, onConfirm }: any) => (
      <span onClick={() => onConfirm?.()}>{children}</span>
    ),
    Space: ({ children }: any) => <div>{children}</div>,
    Table: ({ columns, dataSource, rowKey }: any) => (
      <table>
        <tbody>
          {dataSource.map((record: any) => (
            <tr key={typeof rowKey === 'function' ? rowKey(record) : record[rowKey || 'id']}>
              {columns.map((column: any, index: number) => (
                <td key={column.key ?? column.dataIndex ?? index}>
                  {column.render
                    ? column.render(record[column.dataIndex], record)
                    : String(record[column.dataIndex] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    Tabs: ({ activeKey, items, onChange }: any) => (
      <div>
        <div role="tablist">
          {items.map((item: any) => (
            <button
              type="button"
              role="tab"
              aria-selected={item.key === activeKey}
              key={item.key}
              onClick={() => onChange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {items.find((item: any) => item.key === activeKey)?.children}
      </div>
    ),
    Tag: ({ children }: any) => <span>{children}</span>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
    },
  };
});

vi.mock('../../store/hooks', () => ({
  useAppSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));

vi.mock('../../api', () => ({
  default: apiMocks,
}));

vi.mock('../../utils/notify', () => ({
  notifySuccess: notifyMocks.notifySuccess,
  notifyError: notifyMocks.notifyError,
}));

describe('ApprovalSection capability boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.attendance.capabilities = null;
    state.config.freeeConfigured = false;
    state.config.webCredentialsConfigured = false;
    state.config.oauthConfigured = false;
    apiMocks.getApprovalRequests.mockResolvedValue({
      data: { requests: [], complete: true },
    });
    apiMocks.getIncomingRequests.mockResolvedValue({
      data: { requests: [], complete: true },
    });
  });

  it('shows monthly closing but not OAuth request controls for Web-only accounts', () => {
    state.config.webCredentialsConfigured = true;

    render(<ApprovalSection />);

    expect(screen.getByRole('button', { name: /calendar.monthlyClosing/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /calendar.viewRequests/ })).toBeNull();
  });

  it('shows monthly closing and request controls when OAuth approval is available', () => {
    state.config.oauthConfigured = true;
    state.attendance.capabilities = { approval: true };

    render(<ApprovalSection />);

    expect(screen.getByRole('button', { name: /calendar.monthlyClosing/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /calendar.viewRequests/ })).toBeTruthy();
  });

  it('renders no controls without usable credentials', () => {
    const { container } = render(<ApprovalSection />);
    expect(container.childElementCount).toBe(0);
  });

  it('keeps selection bound to approval type when numeric ids overlap', async () => {
    state.config.oauthConfigured = true;
    state.attendance.capabilities = { approval: true };
    apiMocks.getIncomingRequests.mockResolvedValue({
      data: {
        requests: [
          {
            id: 42,
            type: 'WorkTime',
            status: 'in_progress',
            target_date: '2026-05-12',
            approval_context: approvalContext,
          },
          {
            id: 42,
            type: 'PaidHoliday',
            status: 'in_progress',
            target_date: '2026-05-13',
            approval_context: {
              ...approvalContext,
              request_version: `v1.${'b'.repeat(43)}`,
            },
          },
        ],
        complete: true,
      },
    });
    apiMocks.batchApproveRequests.mockResolvedValue({
      data: { total: 1, succeeded: 1, failed: 0, results: [{ success: true }] },
    });

    render(<ApprovalSection />);
    fireEvent.click(screen.getByRole('button', { name: /calendar.viewRequests/ }));
    fireEvent.click(await screen.findByRole('tab', { name: /calendar.incomingRequests/ }));
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(await screen.findByRole('button', { name: /calendar.batchApprove/ }));

    await waitFor(() => {
      expect(apiMocks.batchApproveRequests).toHaveBeenCalledWith({
        requests: [{
          id: 42,
          type: 'WorkTime',
          action: 'approve',
          expected: approvalContext,
        }],
      });
    });
  });

  it.each([
    ['approve', 'calendar.approve', 'calendar.approved'],
    ['feedback', 'calendar.reject', 'calendar.rejected'],
  ] as const)(
    'does not report a failed single %s action as successful',
    async (action, buttonLabel, actionLabel) => {
      state.config.oauthConfigured = true;
      state.attendance.capabilities = { approval: true };
      apiMocks.getIncomingRequests.mockResolvedValue({
        data: {
          requests: [{
            id: 42,
            type: 'PaidHoliday',
            status: 'in_progress',
            target_date: '2026-05-12',
            applicant: 'Test User',
            approval_context: approvalContext,
          }],
          complete: true,
        },
      });
      apiMocks.batchApproveRequests.mockResolvedValue({
        data: {
          status: 'completed',
          success: false,
          total: 1,
          succeeded: 0,
          failed: 1,
          results: [{ id: 42, success: false, error: 'approval_action_failed' }],
        },
      });

      render(<ApprovalSection />);
      fireEvent.click(screen.getByRole('button', { name: /calendar.viewRequests/ }));
      fireEvent.click(await screen.findByRole('tab', { name: /calendar.incomingRequests/ }));
      fireEvent.click(await screen.findByRole('button', {
        name: (accessibleName) => accessibleName.endsWith(buttonLabel),
      }));

      await waitFor(() => {
        expect(apiMocks.batchApproveRequests).toHaveBeenCalledWith({
          requests: [{
            id: 42,
            type: 'PaidHoliday',
            action,
            expected: approvalContext,
          }],
        });
      });
      expect(notifyMocks.notifySuccess).not.toHaveBeenCalled();
      expect(notifyMocks.notifyError).toHaveBeenCalledWith(`${actionLabel}: common.failed`);
    },
  );

  it.each([['TASK_QUERY_FAILED', 'interrupted-approval', 'tasks.queryPaused'], ['TASK_ADMISSION_UNKNOWN', undefined, 'tasks.admissionUnknown']])('locks a submitted approval after %s', async (code, taskId, message) => {
    state.config.oauthConfigured = true;
    state.attendance.capabilities = { approval: true };
    apiMocks.getIncomingRequests.mockResolvedValue({ data: { requests: [{ id: 42, type: 'PaidHoliday', status: 'in_progress', target_date: '2026-05-12', approval_context: approvalContext }], complete: true } });
    apiMocks.batchApproveRequests.mockRejectedValue({ taskId, code });
    render(<ApprovalSection />);
    fireEvent.click(screen.getByRole('button', { name: /calendar.viewRequests/ }));
    fireEvent.click(await screen.findByRole('tab', { name: /calendar.incomingRequests/ }));
    const approve = await screen.findByRole('button', { name: name => name.endsWith('calendar.approve') });
    fireEvent.click(approve);
    await waitFor(() => expect(notifyMocks.notifyError).toHaveBeenCalledWith(message));
    await waitFor(() => expect(approve).toBeDisabled());
    expect(apiMocks.batchApproveRequests).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('checkbox').every(input => (input as HTMLInputElement).disabled)).toBe(true);
  });

  it('does not submit an incoming record without a complete approval context', async () => {
    state.config.oauthConfigured = true;
    state.attendance.capabilities = { approval: true };
    apiMocks.getIncomingRequests.mockResolvedValue({
      data: {
        requests: [{
          id: 42,
          type: 'PaidHoliday',
          status: 'in_progress',
          target_date: '2026-05-12',
          applicant: 'Test User',
        }],
        complete: true,
      },
    });

    render(<ApprovalSection />);
    fireEvent.click(screen.getByRole('button', { name: /calendar.viewRequests/ }));
    fireEvent.click(await screen.findByRole('tab', { name: /calendar.incomingRequests/ }));

    const approve = await screen.findByRole('button', {
      name: (accessibleName) => accessibleName.endsWith('calendar.approve'),
    });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(approve);
    expect(apiMocks.batchApproveRequests).not.toHaveBeenCalled();
  });
});
