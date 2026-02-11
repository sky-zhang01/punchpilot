import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Select, DatePicker, Input, TimePicker, Space, Typography, Divider, Tag, Alert, Progress } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import api from '../../api';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Text } = Typography;
const { TextArea } = Input;

interface LeaveRequestModalProps {
  open: boolean;
  onClose: () => void;
  preSelectedDates?: string[]; // Dates pre-selected from calendar selection mode (YYYY-MM-DD)
}

const LEAVE_TYPES = [
  { value: 'PaidHoliday', labelKey: 'calendar.paidHoliday' },
  { value: 'SpecialHoliday', labelKey: 'calendar.specialHoliday' },
  { value: 'Absence', labelKey: 'calendar.absence' },
  { value: 'OvertimeWork', labelKey: 'calendar.overtimeWork' },
];

const HOLIDAY_SUBTYPES = [
  { value: 'full', labelKey: 'calendar.holidayTypeFull' },
  { value: 'morning_off', labelKey: 'calendar.holidayTypeMorningOff' },
  { value: 'afternoon_off', labelKey: 'calendar.holidayTypeAfternoonOff' },
  { value: 'half', labelKey: 'calendar.holidayTypeHalf' },
  { value: 'hour', labelKey: 'calendar.holidayTypeHour' },
];

const LeaveRequestModal: React.FC<LeaveRequestModalProps> = ({ open, onClose, preSelectedDates }) => {
  const { t } = useTranslation();
  const [type, setType] = useState<string>('PaidHoliday');
  const [dates, setDates] = useState<Dayjs[]>([]);
  const [reason, setReason] = useState('');
  // Whether dates came from calendar selection (hide internal date picker)
  const hasPreSelectedDates = preSelectedDates && preSelectedDates.length > 0;
  const [holidayType, setHolidayType] = useState<string>('full');
  const [startTime, setStartTime] = useState<Dayjs | null>(null);
  const [endTime, setEndTime] = useState<Dayjs | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ total: number; succeeded: number; failed: number } | null>(null);

  // Sync pre-selected dates from calendar when modal opens
  React.useEffect(() => {
    if (open && hasPreSelectedDates) {
      setDates(preSelectedDates.map(d => dayjs(d)).sort((a, b) => a.valueOf() - b.valueOf()));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether to show time inputs
  const needsTimeInputs = type === 'OvertimeWork' ||
    (type === 'PaidHoliday' && (holidayType === 'half' || holidayType === 'hour'));

  // Batch mode: when multiple dates selected and type supports it (full day leave)
  const isBatchMode = dates.length > 1;

  const handleReset = () => {
    setDates([]);
    setReason('');
    setType('PaidHoliday');
    setHolidayType('full');
    setStartTime(null);
    setEndTime(null);
    setBatchProgress(null);
  };

  const handleDateSelect = (date: Dayjs | null) => {
    if (!date) return;
    const dateStr = date.format('YYYY-MM-DD');
    // Toggle: add if not present, remove if present
    const existing = dates.find(d => d.format('YYYY-MM-DD') === dateStr);
    if (existing) {
      setDates(dates.filter(d => d.format('YYYY-MM-DD') !== dateStr));
    } else {
      setDates([...dates, date].sort((a, b) => a.valueOf() - b.valueOf()));
    }
  };

  const handleRemoveDate = (dateStr: string) => {
    setDates(dates.filter(d => d.format('YYYY-MM-DD') !== dateStr));
  };

  const handleSubmit = async () => {
    if (dates.length === 0 || !type) return;
    if (needsTimeInputs && (!startTime || !endTime)) return;

    setSubmitting(true);
    setBatchProgress(null);

    try {
      if (isBatchMode) {
        // Batch submission
        const data: Record<string, any> = {
          type,
          dates: dates.map(d => d.format('YYYY-MM-DD')),
          reason: reason.trim() || undefined,
        };
        if (type === 'PaidHoliday') {
          data.holiday_type = holidayType;
        }

        const res = await api.submitBatchLeaveRequest(data);
        const result = res.data;
        setBatchProgress({ total: result.total, succeeded: result.succeeded, failed: result.failed });

        if (result.failed > 0) {
          notifyError(`${result.succeeded}/${result.total} ${t('calendar.leaveSubmitted')}, ${result.failed} ${t('common.failed')}`);
        } else {
          notifySuccess(`${result.succeeded} ${t('calendar.leaveSubmitted')}`);
          setTimeout(() => {
            onClose();
            handleReset();
          }, 1500);
        }
      } else {
        // Single submission
        const data: Record<string, any> = {
          type,
          date: dates[0].format('YYYY-MM-DD'),
          reason: reason.trim() || undefined,
        };

        if (type === 'PaidHoliday') {
          data.holiday_type = holidayType;
          if ((holidayType === 'half' || holidayType === 'hour') && startTime && endTime) {
            data.start_time = startTime.format('HH:mm');
            data.end_time = endTime.format('HH:mm');
          }
        }

        if (type === 'OvertimeWork' && startTime && endTime) {
          data.start_time = startTime.format('HH:mm');
          data.end_time = endTime.format('HH:mm');
        }

        await api.submitLeaveRequest(data);
        notifySuccess(t('calendar.leaveSubmitted'));
        onClose();
        handleReset();
      }
    } catch (err: any) {
      const errData = err?.response?.data;
      if (errData?.web_credentials_required) {
        notifyError(t('calendar.batchWebCredsRequired'));
      } else {
        notifyError(errData?.error || t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = dates.length > 0 && type && (!needsTimeInputs || (startTime && endTime));

  return (
    <Modal
      title={t('calendar.leaveRequest')}
      open={open}
      onCancel={() => {
        onClose();
        handleReset();
      }}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okText={isBatchMode ? `${t('calendar.batchSubmit')} (${dates.length})` : t('common.confirm')}
      okButtonProps={{ disabled: !canSubmit }}
      width={480}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Leave type */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            {t('calendar.leaveType')}
          </Text>
          <Select
            value={type}
            onChange={(val) => {
              setType(val);
              setStartTime(null);
              setEndTime(null);
              if (val !== 'PaidHoliday') setHolidayType('full');
            }}
            style={{ width: '100%' }}
            options={LEAVE_TYPES.map(lt => ({
              value: lt.value,
              label: t(lt.labelKey),
            }))}
          />
        </div>

        {/* PaidHoliday subtype selector */}
        {type === 'PaidHoliday' && (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('calendar.holidaySubtype')}
            </Text>
            <Select
              value={holidayType}
              onChange={(val) => {
                setHolidayType(val);
                if (val !== 'hour') {
                  setStartTime(null);
                  setEndTime(null);
                }
              }}
              style={{ width: '100%' }}
              options={HOLIDAY_SUBTYPES.map(ht => ({
                value: ht.value,
                label: t(ht.labelKey),
              }))}
            />
          </div>
        )}

        {/* Date picker - only show when dates are NOT pre-selected from calendar */}
        {!hasPreSelectedDates && (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('table.date')} ({t('calendar.clickToAddDates')})
            </Text>
            <DatePicker
              onChange={handleDateSelect}
              value={null}
              style={{ width: '100%' }}
              placeholder={t('calendar.selectDate')}
            />
          </div>
        )}

        {/* Selected dates display */}
        {dates.length > 0 && (
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              {t('calendar.selectedCount', { count: dates.length })}
            </Text>
            <Space wrap size={[4, 4]}>
              {dates.map(d => {
                const dateStr = d.format('YYYY-MM-DD');
                const dayName = d.format('ddd');
                return (
                  <Tag
                    key={dateStr}
                    closable
                    onClose={() => handleRemoveDate(dateStr)}
                    color="blue"
                    style={{ marginBottom: 0 }}
                  >
                    {dateStr} ({dayName})
                  </Tag>
                );
              })}
            </Space>
          </div>
        )}

        {/* Batch mode notice */}
        {isBatchMode && (
          <Alert
            type="info"
            showIcon
            message={t('calendar.batchLeaveHint', { count: dates.length })}
            style={{ padding: '4px 12px' }}
          />
        )}

        {/* Time inputs for hourly leave or overtime (single date only) */}
        {needsTimeInputs && !isBatchMode && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Space size="middle" style={{ width: '100%' }}>
              <div style={{ flex: 1 }}>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('calendar.startTime')}
                </Text>
                <TimePicker
                  value={startTime}
                  onChange={setStartTime}
                  format="HH:mm"
                  minuteStep={15}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('calendar.endTime')}
                </Text>
                <TimePicker
                  value={endTime}
                  onChange={setEndTime}
                  format="HH:mm"
                  minuteStep={15}
                  style={{ width: '100%' }}
                />
              </div>
            </Space>
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
          />
        </div>

        {/* Batch progress */}
        {batchProgress && (
          <Alert
            type={batchProgress.failed > 0 ? 'warning' : 'success'}
            showIcon
            message={`${batchProgress.succeeded}/${batchProgress.total} ${t('calendar.leaveSubmitted')}${batchProgress.failed > 0 ? `, ${batchProgress.failed} ${t('common.failed')}` : ''}`}
          />
        )}
      </Space>
    </Modal>
  );
};

export default LeaveRequestModal;
