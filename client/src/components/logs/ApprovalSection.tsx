import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Space,
  Typography,
  Modal,
  Alert,
} from 'antd';
import {
  SendOutlined,
} from '@ant-design/icons';
import api from '../../api';
import { useAppSelector } from '../../store/hooks';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Text } = Typography;

/**
 * ApprovalSection — Monthly closing request only.
 *
 * Single-date work time corrections are now handled by BatchPunchModal
 * (unified modal with smart auto-routing).
 *
 * Only shown when:
 * - OAuth is configured
 * - Company has approval capability
 *
 * Renders inline (not in a Card) since it's part of the calendar toolbar area.
 */
const ApprovalSection: React.FC = () => {
  const { t } = useTranslation();
  const { year, month } = useAppSelector((state) => state.attendance);
  const { oauthConfigured } = useAppSelector((state) => state.config);
  const capabilities = useAppSelector((state) => state.attendance.capabilities);

  // Monthly closing
  const [closingLoading, setClosingLoading] = useState(false);
  const [closingConfirm, setClosingConfirm] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  if (!oauthConfigured) return null;

  // Only show this section if approval is available
  if (capabilities && !capabilities.approval) return null;

  const handleMonthlyClosing = async () => {
    setClosingLoading(true);
    setPlanError(null);
    try {
      await api.submitMonthlyAttendance({ year, month });
      notifySuccess(t('calendar.approvalSubmitted'));
      setClosingConfirm(false);
    } catch (err: any) {
      const msg = err?.response?.data?.error || '';
      if (msg.includes('403') || msg.includes('402')) {
        setPlanError(t('calendar.approvalPlanRequired'));
      } else {
        notifyError(msg || t('calendar.approvalFailed'));
      }
    } finally {
      setClosingLoading(false);
    }
  };

  return (
    <>
      {planError && (
        <Alert type="warning" showIcon message={planError} style={{ marginBottom: 8 }} closable onClose={() => setPlanError(null)} />
      )}

      <Space wrap size="small">
        <Button
          icon={<SendOutlined />}
          size="small"
          onClick={() => setClosingConfirm(true)}
        >
          {t('calendar.monthlyClosing')}
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('calendar.monthlyClosingDesc')}
        </Text>
      </Space>

      {/* Monthly closing confirmation modal */}
      <Modal
        title={t('calendar.monthlyClosing')}
        open={closingConfirm}
        onCancel={() => setClosingConfirm(false)}
        onOk={handleMonthlyClosing}
        confirmLoading={closingLoading}
        okText={t('calendar.batchSubmit')}
        cancelText={t('calendar.batchCancel')}
      >
        <Text>
          {t('calendar.monthlyClosingDesc')} ({year}-{String(month).padStart(2, '0')})
        </Text>
      </Modal>
    </>
  );
};

export default ApprovalSection;
