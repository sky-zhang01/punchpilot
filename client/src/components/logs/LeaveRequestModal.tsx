import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Select, DatePicker, Input, Space, Typography } from 'antd';
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
];

const LeaveRequestModal: React.FC<LeaveRequestModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const [type, setType] = useState<string>('PaidHoliday');
  const [date, setDate] = useState<Dayjs | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!date || !type) return;

    setSubmitting(true);
    try {
      await api.submitLeaveRequest({
        type,
        date: date.format('YYYY-MM-DD'),
        reason: reason.trim() || undefined,
      });
      notifySuccess(t('calendar.leaveSubmitted'));
      onClose();
      setDate(null);
      setReason('');
      setType('PaidHoliday');
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t('calendar.leaveRequest')}
      open={open}
      onCancel={() => {
        onClose();
        setDate(null);
        setReason('');
        setType('PaidHoliday');
      }}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okButtonProps={{ disabled: !date || !type }}
      width={400}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            {t('calendar.leaveType')}
          </Text>
          <Select
            value={type}
            onChange={setType}
            style={{ width: '100%' }}
            options={LEAVE_TYPES.map(lt => ({
              value: lt.value,
              label: t(lt.labelKey),
            }))}
          />
        </div>
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
