import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Select, DatePicker, Input, Space, Typography, TimePicker, Switch } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import api from '../../api';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Text } = Typography;
const { TextArea } = Input;

interface WorkRequestModalProps {
  open: boolean;
  onClose: () => void;
}

const WORK_TYPES = [
  { value: 'HolidayWork', labelKey: 'calendar.holidayWork' },
  { value: 'WorkTimeCorrection', labelKey: 'calendar.workTimeCorrection' },
];

const WorkRequestModal: React.FC<WorkRequestModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const [type, setType] = useState<string>('HolidayWork');
  const [date, setDate] = useState<Dayjs | null>(null);
  const [reason, setReason] = useState('');
  const [clockIn, setClockIn] = useState<Dayjs | null>(dayjs().hour(10).minute(0));
  const [clockOut, setClockOut] = useState<Dayjs | null>(dayjs().hour(19).minute(0));
  const [includeBreak, setIncludeBreak] = useState(true);
  const [breakStart, setBreakStart] = useState<Dayjs | null>(dayjs().hour(12).minute(0));
  const [breakEnd, setBreakEnd] = useState<Dayjs | null>(dayjs().hour(13).minute(0));
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setDate(null);
    setReason('');
    setType('HolidayWork');
    setClockIn(dayjs().hour(10).minute(0));
    setClockOut(dayjs().hour(19).minute(0));
    setIncludeBreak(true);
    setBreakStart(dayjs().hour(12).minute(0));
    setBreakEnd(dayjs().hour(13).minute(0));
  };

  const handleSubmit = async () => {
    if (!date || !type) return;

    setSubmitting(true);
    try {
      if (type === 'HolidayWork') {
        // HolidayWork uses the leave-request endpoint (web automation)
        await api.submitLeaveRequest({
          type: 'HolidayWork',
          date: date.format('YYYY-MM-DD'),
          reason: reason.trim() || undefined,
        });
      } else {
        // WorkTimeCorrection uses the approval API endpoint
        const data: Record<string, any> = {
          date: date.format('YYYY-MM-DD'),
          clock_in_at: clockIn ? clockIn.format('HH:mm') : undefined,
          clock_out_at: clockOut ? clockOut.format('HH:mm') : undefined,
          reason: reason.trim() || undefined,
        };
        if (includeBreak && breakStart && breakEnd) {
          data.break_records = [{
            clock_in_at: breakStart.format('HH:mm'),
            clock_out_at: breakEnd.format('HH:mm'),
          }];
        }
        await api.submitWorkTimeCorrection(data);
      }
      notifySuccess(t('calendar.workRequestSubmitted'));
      onClose();
      resetForm();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
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
      okButtonProps={{ disabled: !date || !type || (isCorrection && (!clockIn || !clockOut)) }}
      width={440}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
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
          />
        </div>
      </Space>
    </Modal>
  );
};

export default WorkRequestModal;
