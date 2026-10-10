import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Select, DatePicker, Input, TimePicker, Space, Typography, Divider, Tag, Alert } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import api from '../../api';
import { notifySuccess, notifyError } from '../../utils/notify';
import { type TaskDTO, taskFailure } from '../../tasks';
import { TaskResultSummary } from './TaskRecoveryPanel';

const { Text } = Typography;
const { TextArea } = Input;

interface LeaveRequestModalProps {
  open: boolean;
  onClose: () => void;
  preSelectedDates?: string[]; // Dates pre-selected from calendar selection mode (YYYY-MM-DD)
}

type LeaveRequestPayload = {
  type: string;
  date: string;
  reason?: string;
  holiday_type?: string;
  start_time?: string;
  end_time?: string;
  special_holiday_setting_id?: number;
};

type BatchLeaveRequestPayload = {
  type: string;
  dates: string[];
  reason?: string;
  holiday_type?: string;
  start_time?: string;
  end_time?: string;
  special_holiday_setting_id?: number;
};

type SpecialHolidayOption = {
  setting_id: number;
  name: string;
  usage_day: 'full' | 'half' | 'hour' | null;
  usage_days?: Array<'full' | 'half' | 'hour'>;
  remaining_days: number | null;
  remaining_hours: number | null;
};

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

function specialHolidaySubtypes(option?: SpecialHolidayOption) {
  const usageDays = option?.usage_days?.filter(
    usageDay => ['full', 'half', 'hour'].includes(usageDay),
  ) || (option?.usage_day ? [option.usage_day] : []);
  if (usageDays.length === 0) return HOLIDAY_SUBTYPES;

  const allowedSubtypes = new Set<string>();
  if (usageDays.includes('full')) allowedSubtypes.add('full');
  if (usageDays.includes('half')) {
    allowedSubtypes.add('morning_off');
    allowedSubtypes.add('afternoon_off');
    allowedSubtypes.add('half');
  }
  if (usageDays.includes('hour')) allowedSubtypes.add('hour');
  return HOLIDAY_SUBTYPES.filter(subtype => allowedSubtypes.has(subtype.value));
}

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
  const [specialHolidaySettingId, setSpecialHolidaySettingId] = useState<number | null>(null);
  const [specialHolidayOptions, setSpecialHolidayOptions] = useState<SpecialHolidayOption[]>([]);
  const [specialHolidayOptionsLoading, setSpecialHolidayOptionsLoading] = useState(false);
  const [specialHolidayOptionsUnavailable, setSpecialHolidayOptionsUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [queryPaused, setQueryPaused] = useState(false);
  const [admissionUnknown, setAdmissionUnknown] = useState(false);
  const [batchProgress, setBatchProgress] = useState<TaskDTO | null>(null);

  // Sync pre-selected dates from calendar when modal opens
  React.useEffect(() => {
    if (open && hasPreSelectedDates) {
      setDates(preSelectedDates.map(d => dayjs(d)).sort((a, b) => a.valueOf() - b.valueOf()));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const isBatchMode = dates.length > 1;
  const specialHolidayBatchUnsupported = type === 'SpecialHoliday' && isBatchMode;
  const specialHolidayOptionsDate = dates.length === 1
    ? dates[0].format('YYYY-MM-DD')
    : null;
  React.useEffect(() => {
    if (!open || type !== 'SpecialHoliday' || !specialHolidayOptionsDate) {
      setSpecialHolidayOptions([]);
      setSpecialHolidaySettingId(null);
      setSpecialHolidayOptionsUnavailable(false);
      setSpecialHolidayOptionsLoading(false);
      return;
    }

    let cancelled = false;
    setSpecialHolidayOptionsLoading(true);
    setSpecialHolidayOptionsUnavailable(false);
    api.getSpecialHolidayOptions(specialHolidayOptionsDate)
      .then((response) => {
        if (cancelled) return;
        const options = Array.isArray(response.data?.options) ? response.data.options : [];
        setSpecialHolidayOptions(options);
        setSpecialHolidaySettingId((current) => {
          if (options.some((option: SpecialHolidayOption) => option.setting_id === current)) {
            return current;
          }
          return options.length === 1 ? options[0].setting_id : null;
        });
        setSpecialHolidayOptionsUnavailable(options.length === 0);
      })
      .catch(() => {
        if (cancelled) return;
        setSpecialHolidayOptions([]);
        setSpecialHolidaySettingId(null);
        setSpecialHolidayOptionsUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setSpecialHolidayOptionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, type, specialHolidayOptionsDate]);

  const selectedSpecialHolidayOption = React.useMemo(
    () => specialHolidayOptions.find(
      option => option.setting_id === specialHolidaySettingId,
    ),
    [specialHolidayOptions, specialHolidaySettingId],
  );
  const availableSpecialHolidaySubtypes = React.useMemo(
    () => specialHolidaySubtypes(selectedSpecialHolidayOption),
    [selectedSpecialHolidayOption],
  );

  React.useEffect(() => {
    if (
      type !== 'SpecialHoliday' ||
      !specialHolidaySettingId ||
      availableSpecialHolidaySubtypes.some(subtype => subtype.value === holidayType)
    ) {
      return;
    }
    setHolidayType(availableSpecialHolidaySubtypes[0]?.value || 'full');
    setStartTime(null);
    setEndTime(null);
  }, [
    type,
    specialHolidaySettingId,
    availableSpecialHolidaySubtypes,
    holidayType,
  ]);

  // Whether to show time inputs
  const needsTimeInputs = type === 'OvertimeWork' ||
    (['PaidHoliday', 'SpecialHoliday'].includes(type) &&
      (holidayType === 'half' || holidayType === 'hour'));

  const handleReset = () => {
    setDates([]);
    setReason('');
    setType('PaidHoliday');
    setHolidayType('full');
    setStartTime(null);
    setEndTime(null);
    setSpecialHolidaySettingId(null);
    setSpecialHolidayOptions([]);
    setSpecialHolidayOptionsLoading(false);
    setSpecialHolidayOptionsUnavailable(false);
    setBatchProgress(null);
    setQueryPaused(false);
    setAdmissionUnknown(false);
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
    if (specialHolidayBatchUnsupported) return;
    if (needsTimeInputs && (!startTime || !endTime)) return;

    setSubmitting(true);
    setBatchProgress(null);

    try {
      if (isBatchMode) {
        // Batch submission
        const data: BatchLeaveRequestPayload = {
          type,
          dates: dates.map(d => d.format('YYYY-MM-DD')),
          reason: reason.trim() || undefined,
        };
        if (type === 'PaidHoliday') {
          data.holiday_type = holidayType;
        }
        if (type === 'SpecialHoliday' && specialHolidaySettingId) {
          data.special_holiday_setting_id = specialHolidaySettingId;
        }

        if (needsTimeInputs && startTime && endTime) {
          data.start_time = startTime.format('HH:mm');
          data.end_time = endTime.format('HH:mm');
        }
        const res = await api.submitBatchLeaveRequest(data);
        const result = res.data;
        setBatchProgress(result);

        if (!result.success) {
          notifyError(`${result.succeeded}/${result.total} ${t('calendar.leaveSubmitted')}, ${result.failed} ${t('common.failed')}`);
        } else {
          notifySuccess(`${result.succeeded} ${t('calendar.leaveSubmitted')}`);
          onClose();
          handleReset();
        }
      } else {
        // Single submission
        const data: LeaveRequestPayload = {
          type,
          date: dates[0].format('YYYY-MM-DD'),
          reason: reason.trim() || undefined,
        };

        if (type === 'PaidHoliday' || type === 'SpecialHoliday') {
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
        if (type === 'SpecialHoliday' && specialHolidaySettingId) {
          data.special_holiday_setting_id = specialHolidaySettingId;
        }

        await api.submitLeaveRequest(data);
        notifySuccess(t('calendar.leaveSubmitted'));
        onClose();
        handleReset();
      }
    } catch (err: any) {
      const failure = taskFailure(err);
      if (err?.code === 'TASK_ADMISSION_UNKNOWN') { setQueryPaused(true); setAdmissionUnknown(true); }
      if (failure) { setBatchProgress(failure.task); setQueryPaused(true); }
      const errData = err?.response?.data;
      if (errData?.web_credentials_required) {
        notifyError(t('calendar.batchWebCredsRequired'));
      } else {
        notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : failure ? t('tasks.queryPaused') : errData?.error || t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const hasSpecialHolidaySetting = type !== 'SpecialHoliday' || !!specialHolidaySettingId;
  const canSubmit = Boolean(!batchProgress && !queryPaused && !submitting && dates.length > 0 && type && hasSpecialHolidaySetting &&
    !specialHolidayBatchUnsupported &&
    !specialHolidayOptionsLoading &&
    (!needsTimeInputs || (startTime && endTime)));

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
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
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
              setSpecialHolidaySettingId(null);
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
              aria-label={t('calendar.holidaySubtype')}
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

        {type === 'SpecialHoliday' && specialHolidayOptionsDate && (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('calendar.specialHolidaySetting')}
            </Text>
            <Select
              aria-label={t('calendar.specialHolidaySetting')}
              value={specialHolidaySettingId}
              onChange={setSpecialHolidaySettingId}
              loading={specialHolidayOptionsLoading}
              placeholder={t('calendar.selectSpecialHolidaySetting')}
              style={{ width: '100%' }}
              options={specialHolidayOptions.map(option => ({
                value: option.setting_id,
                label: option.name,
              }))}
            />
            {specialHolidayOptionsUnavailable && (
              <Alert
                type="warning"
                showIcon
                message={t('calendar.specialHolidaySettingsUnavailable')}
                style={{ marginTop: 8, padding: '4px 12px' }}
              />
            )}
          </div>
        )}

        {type === 'SpecialHoliday' && specialHolidaySettingId && (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('calendar.holidaySubtype')}
            </Text>
            <Select
              aria-label={t('calendar.holidaySubtype')}
              value={holidayType}
              onChange={(val) => {
                setHolidayType(val);
                if (val !== 'half' && val !== 'hour') {
                  setStartTime(null);
                  setEndTime(null);
                }
              }}
              style={{ width: '100%' }}
              options={availableSpecialHolidaySubtypes.map(subtype => ({
                value: subtype.value,
                label: t(subtype.labelKey),
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
        {specialHolidayBatchUnsupported ? (
          <Alert
            type="warning"
            showIcon
            message={t('calendar.specialHolidaySingleDateOnly')}
            style={{ padding: '4px 12px' }}
          />
        ) : isBatchMode && (
          <Alert
            type="info"
            showIcon
            message={t('calendar.batchLeaveHint', { count: dates.length })}
            style={{ padding: '4px 12px' }}
          />
        )}

        {/* Time inputs for hourly leave or overtime */}
        {needsTimeInputs && (
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
            maxLength={255}
          />
        </div>

        {queryPaused && <Alert type="warning" showIcon message={t(admissionUnknown ? 'tasks.admissionUnknown' : 'tasks.queryPaused')} />}
        {/* Batch progress */}
        {batchProgress && <TaskResultSummary task={batchProgress} />}
      </Space>
    </Modal>
  );
};

export default LeaveRequestModal;
