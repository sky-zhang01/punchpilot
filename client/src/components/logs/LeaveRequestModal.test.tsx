import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LeaveRequestModal from './LeaveRequestModal';

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const apiMocks = vi.hoisted(() => ({
  getSpecialHolidayOptions: vi.fn(),
  submitLeaveRequest: vi.fn(),
  submitBatchLeaveRequest: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../api', () => ({
  default: apiMocks,
}));

vi.mock('../../utils/notify', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    Alert: ({ message }: { message: React.ReactNode }) => (
      <div role="alert">{message}</div>
    ),
    Modal: ({
      children,
      open,
      onOk,
      okButtonProps,
      okText,
    }: {
      children: React.ReactNode;
      open: boolean;
      onOk: () => void;
      okButtonProps?: { disabled?: boolean };
      okText: React.ReactNode;
    }) => open ? (
      <div role="dialog">
        {children}
        <button type="button" onClick={onOk} disabled={okButtonProps?.disabled}>
          {okText}
        </button>
      </div>
    ) : null,
    Select: ({
      'aria-label': ariaLabel,
      value,
      onChange,
      options = [],
    }: {
      'aria-label'?: string;
      value?: string | number | null;
      onChange: (value: any) => void;
      options?: Array<{ value: string | number; label: React.ReactNode }>;
    }) => (
      <select
        aria-label={ariaLabel}
        value={value ?? ''}
        onChange={(event) => {
          const option = options.find(item => String(item.value) === event.target.value);
          onChange(option?.value ?? event.target.value);
        }}
      >
        <option value="" />
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    ),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('LeaveRequestModal safety boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.submitLeaveRequest.mockResolvedValue({ data: { success: true } });
    apiMocks.submitBatchLeaveRequest.mockResolvedValue({
      data: { total: 2, succeeded: 2, failed: 0 },
    });
  });

  it('clears special-holiday loading when the request type changes', async () => {
    const pendingOptions = deferred<{ data: { options: never[] } }>();
    apiMocks.getSpecialHolidayOptions.mockReturnValue(pendingOptions.promise);

    render(
      <LeaveRequestModal
        open
        onClose={vi.fn()}
        preSelectedDates={['2026-05-12']}
      />,
    );

    const confirmButton = await screen.findByRole('button', { name: 'common.confirm' });
    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'SpecialHoliday' },
    });
    await waitFor(() => expect(apiMocks.getSpecialHolidayOptions).toHaveBeenCalledWith('2026-05-12'));
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'PaidHoliday' },
    });
    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(apiMocks.submitLeaveRequest).toHaveBeenCalledWith(expect.objectContaining({
        type: 'PaidHoliday',
        date: '2026-05-12',
      }));
    });
    pendingOptions.resolve({ data: { options: [] } });
  });

  it('blocks multi-date special-holiday submissions before loading options', async () => {
    render(
      <LeaveRequestModal
        open
        onClose={vi.fn()}
        preSelectedDates={['2026-05-12', '2026-05-13']}
      />,
    );

    const submitButton = await screen.findByRole('button', {
      name: 'calendar.batchSubmit (2)',
    });
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'SpecialHoliday' },
    });

    expect((await screen.findByRole('alert')).textContent).toContain('calendar.specialHolidaySingleDateOnly');
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submitButton);
    expect(apiMocks.getSpecialHolidayOptions).not.toHaveBeenCalled();
    expect(apiMocks.submitBatchLeaveRequest).not.toHaveBeenCalled();
  });

  it('blocks re-submission when batch admission has no task id', async () => {
    apiMocks.submitBatchLeaveRequest.mockRejectedValue({ code: 'TASK_ADMISSION_UNKNOWN' });
    render(<LeaveRequestModal open onClose={vi.fn()} preSelectedDates={['2026-05-12', '2026-05-13']} />);
    const button = await screen.findByRole('button', { name: 'calendar.batchSubmit (2)' });
    fireEvent.click(button);
    await screen.findByText('tasks.admissionUnknown');
    expect(button).toBeDisabled();
    expect(apiMocks.submitBatchLeaveRequest).toHaveBeenCalledTimes(1);
  });

  it('uses the selected special-holiday setting usage and submits its subtype', async () => {
    apiMocks.getSpecialHolidayOptions.mockResolvedValue({
      data: {
        options: [{
          setting_id: 42,
          name: 'Half-day special leave',
          usage_day: 'half',
          usage_days: ['half'],
          remaining_days: 2,
          remaining_hours: 0,
        }],
      },
    });
    render(
      <LeaveRequestModal
        open
        onClose={vi.fn()}
        preSelectedDates={['2026-05-12']}
      />,
    );

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'SpecialHoliday' },
    });

    const settingSelect = await screen.findByLabelText('calendar.specialHolidaySetting');
    await waitFor(() => expect((settingSelect as HTMLSelectElement).value).toBe('42'));
    const subtypeSelect = await screen.findByLabelText('calendar.holidaySubtype');
    expect(screen.queryByRole('option', { name: 'calendar.holidayTypeFull' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'calendar.holidayTypeHour' })).toBeNull();
    expect(screen.getByRole('option', { name: 'calendar.holidayTypeMorningOff' })).toBeTruthy();

    fireEvent.change(subtypeSelect, { target: { value: 'morning_off' } });
    const confirmButton = screen.getByRole('button', { name: 'common.confirm' });
    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirmButton);

    await waitFor(() => expect(apiMocks.submitLeaveRequest).toHaveBeenCalledWith({
      type: 'SpecialHoliday',
      date: '2026-05-12',
      reason: undefined,
      holiday_type: 'morning_off',
      special_holiday_setting_id: 42,
    }));
  });
});
