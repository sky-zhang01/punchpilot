import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Select, DatePicker, Input, Space, Typography, TimePicker, Switch, Tag, Alert } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import api from '../../api';
import { notifySuccess, notifyError } from '../../utils/notify';
import { taskFailure, type TaskDTO } from '../../tasks';
import { TaskResultSummary } from './TaskRecoveryPanel';
import { useAppSelector } from '../../store/hooks';
import { isTimeString } from '../../../../shared/date-time.js';

const { Text } = Typography;
const { TextArea } = Input;

interface WorkRequestModalProps {
  open: boolean;
  onClose: () => void;
  preSelectedDates?: string[]; // Dates pre-selected from calendar selection mode (YYYY-MM-DD)
}

const WORK_TYPES = [
  { value: 'HolidayWork', labelKey: 'calendar.holidayWork' },
  { value: 'WorkTimeCorrection', labelKey: 'calendar.workTimeCorrection' },
];

const WorkRequestModal: React.FC<WorkRequestModalProps> = ({ open, onClose, preSelectedDates }) => {
  const { t } = useTranslation();
  const schedules = useAppSelector(state => state.config.schedules);
  const initialized = React.useRef(false);
  const [type, setType] = useState<string>('HolidayWork');
  const [date, setDate] = useState<Dayjs | null>(null);
  const hasPreSelectedDates = preSelectedDates && preSelectedDates.length > 0;
  const [reason, setReason] = useState('');
  const [clockIn, setClockIn] = useState<Dayjs | null>(null);
  const [clockOut, setClockOut] = useState<Dayjs | null>(null);
  const [includeBreak, setIncludeBreak] = useState(true);
  const [breakStart, setBreakStart] = useState<Dayjs | null>(null);
  const [breakEnd, setBreakEnd] = useState<Dayjs | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [task, setTask] = useState<TaskDTO | null>(null);
  const [queryPaused, setQueryPaused] = useState(false);
  const [admissionUnknown, setAdmissionUnknown] = useState(false);

  React.useEffect(() => {
    if (!open) { initialized.current = false; return; }
    if (hasPreSelectedDates) setDate(dayjs(preSelectedDates[0]));
    if (initialized.current || schedules.length === 0) return;
    initialized.current = true;
    const savedTime = (action: string) => {
      const time = schedules.find(schedule => schedule.action_type === action)?.fixed_time;
      return isTimeString(time) ? dayjs(`2000-01-01T${time}:00`) : null;
    };
    setClockIn(savedTime('checkin')); setClockOut(savedTime('checkout'));
    setBreakStart(savedTime('break_start')); setBreakEnd(savedTime('break_end'));
  }, [open, schedules]);

  const resetForm = () => {
    setTask(null);
    setQueryPaused(false);
    setAdmissionUnknown(false);
    setDate(null);
    setReason('');
    setType('HolidayWork');
    setClockIn(null);
    setClockOut(null);
    setIncludeBreak(true);
    setBreakStart(null);
    setBreakEnd(null);
  };

  const handleSubmit = async () => {
    const datesToSubmit = hasPreSelectedDates ? preSelectedDates : (date ? [date.format('YYYY-MM-DD')] : []);
    if (datesToSubmit.length === 0 || !type) return;

    setSubmitting(true);
    try {
      const response = type === 'HolidayWork'
        ? await api.submitBatchLeaveRequest({
            type: 'HolidayWork',
            dates: datesToSubmit,
            reason: reason.trim() || undefined,
          })
        : await api.submitBatch({
            entries: datesToSubmit.map(dateStr => ({
              date: dateStr,
              clock_in_at: clockIn?.format('HH:mm'),
              clock_out_at: clockOut?.format('HH:mm'),
              ...(includeBreak && breakStart && breakEnd
                ? {
                    break_records: [{
                      clock_in_at: breakStart.format('HH:mm'),
                      clock_out_at: breakEnd.format('HH:mm'),
                    }],
                  }
                : {}),
            })),
            reason: reason.trim() || undefined,
          });
      setTask(response.data);
      if (response.data.success) {
        notifySuccess(`${response.data.succeeded} ${t('calendar.workRequestSubmitted')}`);
        onClose();
        resetForm();
      }
    } catch (err: any) {
      const failure = taskFailure(err);
      if (err?.code === 'TASK_ADMISSION_UNKNOWN') { setQueryPaused(true); setAdmissionUnknown(true); }
      if (failure) { setTask(failure.task); setQueryPaused(true); }
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : failure ? t('tasks.queryPaused') : err?.response?.data?.error || t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const isCorrection = type === 'WorkTimeCorrection';

  return (
    <Modal
      title={t('calendar.workRequest')}
      open={open}
      onCancel={() => { onClose(); resetForm(); }}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okText={hasPreSelectedDates && preSelectedDates.length > 1 ? `${t('calendar.batchSubmit')} (${preSelectedDates.length})` : t('common.confirm')}
      okButtonProps={{ disabled: !!task || queryPaused || submitting || (!date && !hasPreSelectedDates) || !type || (isCorrection && (!clockIn || !clockOut || (includeBreak && (!breakStart || !breakEnd)))) }}
      width={440}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {task && <TaskResultSummary task={task} />}
        {queryPaused && <Alert type="warning" showIcon message={t(admissionUnknown ? 'tasks.admissionUnknown' : 'tasks.queryPaused')} />}
        {/* Request type */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            {t('calendar.workRequestType')}
          </Text>
          <Select
            value={type}
            onChange={setType}
            style={{ width: '100%' }}
            options={WORK_TYPES.map(wt => ({
              value: wt.value,
              label: t(wt.labelKey),
            }))}
          />
        </div>

        {/* Date — hide picker when dates come from calendar */}
        {hasPreSelectedDates ? (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('table.date')} ({t('calendar.selectedCount', { count: preSelectedDates.length })})
            </Text>
            <Space wrap size={[4, 4]}>
              {preSelectedDates.map(d => (
                <Tag key={d} color="blue">{d} ({dayjs(d).format('ddd')})</Tag>
              ))}
            </Space>
          </div>
        ) : (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('table.date')}
            </Text>
            <DatePicker
              value={date}
              onChange={setDate}
              style={{ width: '100%' }}
            />
          </div>
        )}

        {/* Time fields for WorkTimeCorrection */}
        {isCorrection && (
          <>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('calendar.batchCheckin')}
                </Text>
                <TimePicker
                  value={clockIn}
                  onChange={setClockIn}
                  format="HH:mm"
                  minuteStep={5}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('calendar.batchCheckout')}
                </Text>
                <TimePicker
                  value={clockOut}
                  onChange={setClockOut}
                  format="HH:mm"
                  minuteStep={5}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            {/* Break toggle */}
            <div>
              <Space>
                <Switch checked={includeBreak} onChange={setIncludeBreak} size="small" />
                <Text>{t('calendar.batchBreak')}</Text>
              </Space>
            </div>

            {includeBreak && (
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>
                    {t('calendar.batchBreakStart')}
                  </Text>
                  <TimePicker
                    value={breakStart}
                    onChange={setBreakStart}
                    format="HH:mm"
                    minuteStep={5}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>
                    {t('calendar.batchBreakEnd')}
                  </Text>
                  <TimePicker
                    value={breakEnd}
                    onChange={setBreakEnd}
                    format="HH:mm"
                    minuteStep={5}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {/* Reason */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            {t('calendar.correctionReason')}
          </Text>
          <TextArea
            placeholder={t('calendar.correctionReasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={255}
          />
        </div>
      </Space>
    </Modal>
  );
};

export default WorkRequestModal;
