import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Select, DatePicker, Input, TimePicker, Space, Typography, Divider } from 'antd';
import type { Dayjs } from 'dayjs';
import api from '../../api';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Text } = Typography;
const { TextArea } = Input;

interface LeaveRequestModalProps {
  open: boolean;
  onClose: () => void;
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

const LeaveRequestModal: React.FC<LeaveRequestModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const [type, setType] = useState<string>('PaidHoliday');
  const [date, setDate] = useState<Dayjs | null>(null);
  const [reason, setReason] = useState('');
  const [holidayType, setHolidayType] = useState<string>('full');
  const [startTime, setStartTime] = useState<Dayjs | null>(null);
  const [endTime, setEndTime] = useState<Dayjs | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Whether to show time inputs
  const needsTimeInputs = type === 'OvertimeWork' ||
    (type === 'PaidHoliday' && (holidayType === 'half' || holidayType === 'hour'));

  const handleReset = () => {
    setDate(null);
    setReason('');
    setType('PaidHoliday');
    setHolidayType('full');
    setStartTime(null);
    setEndTime(null);
  };

  const handleSubmit = async () => {
    if (!date || !type) return;
    if (needsTimeInputs && (!startTime || !endTime)) return;

    setSubmitting(true);
    try {
      const data: Record<string, any> = {
        type,
        date: date.format('YYYY-MM-DD'),
        reason: reason.trim() || undefined,
      };

      // PaidHoliday subtypes
      if (type === 'PaidHoliday') {
        data.holiday_type = holidayType;
        if ((holidayType === 'half' || holidayType === 'hour') && startTime && endTime) {
          data.start_time = startTime.format('HH:mm');
          data.end_time = endTime.format('HH:mm');
        }
      }

      // OvertimeWork requires times
      if (type === 'OvertimeWork' && startTime && endTime) {
        data.start_time = startTime.format('HH:mm');
        data.end_time = endTime.format('HH:mm');
      }

      await api.submitLeaveRequest(data);
      notifySuccess(t('calendar.leaveSubmitted'));
      onClose();
      handleReset();
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

  const canSubmit = date && type && (!needsTimeInputs || (startTime && endTime));

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
      okButtonProps={{ disabled: !canSubmit }}
      width={440}
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
              // Reset time inputs when changing type
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

        {/* Date */}
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
          />
        </div>
      </Space>
    </Modal>
  );
};

export default LeaveRequestModal;
