import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Space,
  Typography,
  Modal,
  Alert,
  Table,
  Tag,
  Popconfirm,
  Checkbox,
  Tabs,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SendOutlined,
  UnorderedListOutlined,
  RollbackOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import api from '../../api';
import { useAppSelector } from '../../store/hooks';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Text } = Typography;

// Status tag colors
const STATUS_COLORS: Record<string, string> = {
  in_progress: 'processing',
  approved: 'success',
  feedback: 'warning',
  draft: 'default',
};

// Type label mapping
const TYPE_I18N_MAP: Record<string, string> = {
  PaidHoliday: 'leaveTypes.paidHoliday',
  SpecialHoliday: 'leaveTypes.specialHoliday',
  OvertimeWork: 'leaveTypes.overtimeWork',
  Absence: 'leaveTypes.absence',
  WorkTime: 'calendar.workTimeCorrection',
  MonthlyAttendance: 'calendar.monthlyClosing',
};

interface ApprovalRequest {
  id: number;
  type: string;
  status: string;
  target_date?: string;
  comment?: string;
  created_at?: string;
}

interface IncomingRequest {
  id: number;
  type: string;
  status: string;
  target_date?: string;
  applicant?: string;
  applicant_id?: number;
  comment?: string;
  created_at?: string;
  current_round?: number;
  current_step_id?: number;
}

/**
 * ApprovalSection — Monthly closing + View/Withdraw approval requests + Incoming requests.
 *
 * Features:
 * - Monthly closing submission
 * - My requests: view, batch withdraw
 * - Incoming requests: view, batch approve/reject
 *
 * Only shown when:
 * - OAuth is configured
 * - Company has approval capability
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

  // Approval requests list (my requests)
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<number | null>(null);
  const [selectedMyIds, setSelectedMyIds] = useState<number[]>([]);
  const [batchWithdrawLoading, setBatchWithdrawLoading] = useState(false);

  // Incoming requests (for approval)
  const [incomingRequests, setIncomingRequests] = useState<IncomingRequest[]>([]);
  const [incomingLoading, setIncomingLoading] = useState(false);
  const [selectedIncomingIds, setSelectedIncomingIds] = useState<number[]>([]);
  const [batchApproveLoading, setBatchApproveLoading] = useState(false);

  // Active tab in modal
  const [activeTab, setActiveTab] = useState('my');

  if (!oauthConfigured) return null;
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

  // --- My Requests ---
  const loadRequests = async () => {
    setRequestsLoading(true);
    try {
      const res = await api.getApprovalRequests(year, month);
      setRequests(res.data.requests || []);
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
      setRequests([]);
    } finally {
      setRequestsLoading(false);
    }
  };

  // --- Incoming Requests ---
  const loadIncomingRequests = async () => {
    setIncomingLoading(true);
    try {
      const res = await api.getIncomingRequests(year, month);
      setIncomingRequests(res.data.requests || []);
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
      setIncomingRequests([]);
    } finally {
      setIncomingLoading(false);
    }
  };

  const handleOpenRequests = () => {
    setRequestsOpen(true);
    setSelectedMyIds([]);
    setSelectedIncomingIds([]);
    loadRequests();
    loadIncomingRequests();
  };

  const handleWithdraw = async (record: ApprovalRequest) => {
    setWithdrawingId(record.id);
    try {
      await api.withdrawApprovalRequest(record.id, record.type);
      notifySuccess(t('calendar.withdrawSuccess'));
      loadRequests();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('calendar.withdrawFailed'));
    } finally {
      setWithdrawingId(null);
    }
  };

  // Batch withdraw selected requests
  const handleBatchWithdraw = async () => {
    const toWithdraw = requests
      .filter(r => selectedMyIds.includes(r.id) && (r.status === 'in_progress' || r.status === 'draft'))
      .map(r => ({ id: r.id, type: r.type }));

    if (toWithdraw.length === 0) {
      notifyError(t('calendar.noWithdrawable'));
      return;
    }

    setBatchWithdrawLoading(true);
    try {
      const res = await api.batchWithdrawRequests({ requests: toWithdraw });
      const data = res.data;
      if (data.failed > 0) {
        notifyError(`${data.succeeded}/${toWithdraw.length} ${t('calendar.withdrawSuccess')}, ${data.failed} ${t('calendar.withdrawFailed')}`);
      } else {
        notifySuccess(`${data.succeeded} ${t('calendar.withdrawSuccess')}`);
      }
      setSelectedMyIds([]);
      loadRequests();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('calendar.withdrawFailed'));
    } finally {
      setBatchWithdrawLoading(false);
    }
  };

  // Batch approve or reject incoming requests
  const handleBatchApproveAction = async (action: 'approve' | 'feedback') => {
    const selected = incomingRequests
      .filter(r => selectedIncomingIds.includes(r.id))
      .map(r => ({ id: r.id, type: r.type, action }));

    if (selected.length === 0) return;

    setBatchApproveLoading(true);
    try {
      const res = await api.batchApproveRequests({ requests: selected });
      const data = res.data;
      const actionLabel = action === 'approve' ? t('calendar.approved') : t('calendar.rejected');
      if (data.failed > 0) {
        notifyError(`${data.succeeded}/${selected.length} ${actionLabel}, ${data.failed} ${t('common.failed')}`);
      } else {
        notifySuccess(`${data.succeeded} ${actionLabel}`);
      }
      setSelectedIncomingIds([]);
      loadIncomingRequests();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
    } finally {
      setBatchApproveLoading(false);
    }
  };

  // --- My Requests Table ---
  const withdrawableIds = requests.filter(r => r.status === 'in_progress' || r.status === 'draft').map(r => r.id);

  const myRequestColumns: ColumnsType<ApprovalRequest> = [
    {
      title: (
        <Checkbox
          checked={withdrawableIds.length > 0 && withdrawableIds.every(id => selectedMyIds.includes(id))}
          indeterminate={selectedMyIds.length > 0 && selectedMyIds.length < withdrawableIds.length}
          onChange={(e) => setSelectedMyIds(e.target.checked ? withdrawableIds : [])}
          disabled={withdrawableIds.length === 0}
        />
      ),
      key: 'select',
      width: 40,
      render: (_: any, record: ApprovalRequest) => {
        const canSelect = record.status === 'in_progress' || record.status === 'draft';
        if (!canSelect) return null;
        return (
          <Checkbox
            checked={selectedMyIds.includes(record.id)}
            onChange={(e) => {
              setSelectedMyIds(prev =>
                e.target.checked ? [...prev, record.id] : prev.filter(id => id !== record.id)
              );
            }}
          />
        );
      },
    },
    {
      title: t('table.date'),
      dataIndex: 'target_date',
      key: 'date',
      width: 120,
      render: (val: string) => val || '-',
    },
    {
      title: t('table.type'),
      dataIndex: 'type',
      key: 'type',
      width: 140,
      render: (val: string) => t(TYPE_I18N_MAP[val] || val),
    },
    {
      title: t('table.status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (val: string) => (
        <Tag color={STATUS_COLORS[val] || 'default'}>
          {t(`approvalStatus.${val}`) || val}
        </Tag>
      ),
    },
    {
      title: t('table.actions'),
      key: 'actions',
      width: 100,
      render: (_: any, record: ApprovalRequest) => {
        const canWithdraw = record.status === 'in_progress' || record.status === 'draft';
        if (!canWithdraw) return null;
        return (
          <Popconfirm
            title={t('calendar.withdrawConfirm')}
            onConfirm={() => handleWithdraw(record)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button
              type="link"
              danger
              size="small"
              icon={<RollbackOutlined />}
              loading={withdrawingId === record.id}
            >
              {t('calendar.withdrawApproval')}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  // --- Incoming Requests Table ---
  const incomingColumns: ColumnsType<IncomingRequest> = [
    {
      title: (
        <Checkbox
          checked={incomingRequests.length > 0 && selectedIncomingIds.length === incomingRequests.length}
          indeterminate={selectedIncomingIds.length > 0 && selectedIncomingIds.length < incomingRequests.length}
          onChange={(e) => setSelectedIncomingIds(e.target.checked ? incomingRequests.map(r => r.id) : [])}
          disabled={incomingRequests.length === 0}
        />
      ),
      key: 'select',
      width: 40,
      render: (_: any, record: IncomingRequest) => (
        <Checkbox
          checked={selectedIncomingIds.includes(record.id)}
          onChange={(e) => {
            setSelectedIncomingIds(prev =>
              e.target.checked ? [...prev, record.id] : prev.filter(id => id !== record.id)
            );
          }}
        />
      ),
    },
    {
      title: t('table.date'),
      dataIndex: 'target_date',
      key: 'date',
      width: 110,
      render: (val: string) => val || '-',
    },
    {
      title: t('table.type'),
      dataIndex: 'type',
      key: 'type',
      width: 130,
      render: (val: string) => t(TYPE_I18N_MAP[val] || val),
    },
    {
      title: t('table.applicant'),
      dataIndex: 'applicant',
      key: 'applicant',
      width: 120,
    },
    {
      title: t('table.status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (val: string) => (
        <Tag color={STATUS_COLORS[val] || 'default'}>
          {t(`approvalStatus.${val}`) || val}
        </Tag>
      ),
    },
    {
      title: t('table.actions'),
      key: 'actions',
      width: 160,
      render: (_: any, record: IncomingRequest) => (
        <Space size="small">
          <Popconfirm
            title={t('calendar.approveConfirm')}
            onConfirm={async () => {
              try {
                await api.batchApproveRequests({ requests: [{ id: record.id, type: record.type, action: 'approve' }] });
                notifySuccess(t('calendar.approved'));
                loadIncomingRequests();
              } catch (err: any) {
                notifyError(err?.response?.data?.error || t('common.error'));
              }
            }}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }}>
              {t('calendar.approve')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('calendar.rejectConfirm')}
            onConfirm={async () => {
              try {
                await api.batchApproveRequests({ requests: [{ id: record.id, type: record.type, action: 'feedback' }] });
                notifySuccess(t('calendar.rejected'));
                loadIncomingRequests();
              } catch (err: any) {
                notifyError(err?.response?.data?.error || t('common.error'));
              }
            }}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button type="link" danger size="small" icon={<CloseCircleOutlined />}>
              {t('calendar.reject')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

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
        <Button
          icon={<UnorderedListOutlined />}
          size="small"
          onClick={handleOpenRequests}
        >
          {t('calendar.viewRequests')}
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

      {/* Approval requests modal with tabs */}
      <Modal
        title={t('calendar.approvalRequests')}
        open={requestsOpen}
        onCancel={() => setRequestsOpen(false)}
        footer={null}
        width={800}
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          {year}-{String(month).padStart(2, '0')}
        </Text>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'my',
              label: (
                <Space size={4}>
                  <UnorderedListOutlined />
                  {t('calendar.myRequests')} ({requests.length})
                </Space>
              ),
              children: (
                <>
                  {selectedMyIds.length > 0 && (
                    <Space style={{ marginBottom: 8 }}>
                      <Text type="secondary">
                        {t('calendar.selectedCount', { count: selectedMyIds.length })}
                      </Text>
                      <Popconfirm
                        title={t('calendar.batchWithdrawConfirm')}
                        onConfirm={handleBatchWithdraw}
                        okText={t('common.confirm')}
                        cancelText={t('common.cancel')}
                      >
                        <Button
                          danger
                          size="small"
                          icon={<RollbackOutlined />}
                          loading={batchWithdrawLoading}
                        >
                          {t('calendar.batchWithdraw')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  )}
                  <Table<ApprovalRequest>
                    columns={myRequestColumns}
                    dataSource={requests}
                    rowKey="id"
                    loading={requestsLoading}
                    size="small"
                    pagination={false}
                    locale={{ emptyText: t('calendar.noRequests') }}
                  />
                </>
              ),
            },
            {
              key: 'incoming',
              label: (
                <Space size={4}>
                  <InboxOutlined />
                  {t('calendar.incomingRequests')} ({incomingRequests.length})
                </Space>
              ),
              children: (
                <>
                  {selectedIncomingIds.length > 0 && (
                    <Space style={{ marginBottom: 8 }}>
                      <Text type="secondary">
                        {t('calendar.selectedCount', { count: selectedIncomingIds.length })}
                      </Text>
                      <Button
                        type="primary"
                        size="small"
                        icon={<CheckCircleOutlined />}
                        loading={batchApproveLoading}
                        onClick={() => handleBatchApproveAction('approve')}
                        style={{ background: '#52c41a', borderColor: '#52c41a' }}
                      >
                        {t('calendar.batchApprove')}
                      </Button>
                      <Button
                        danger
                        size="small"
                        icon={<CloseCircleOutlined />}
                        loading={batchApproveLoading}
                        onClick={() => handleBatchApproveAction('feedback')}
                      >
                        {t('calendar.batchReject')}
                      </Button>
                    </Space>
                  )}
                  <Table<IncomingRequest>
                    columns={incomingColumns}
                    dataSource={incomingRequests}
                    rowKey="id"
                    loading={incomingLoading}
                    size="small"
                    pagination={false}
                    locale={{ emptyText: t('calendar.noIncomingRequests') }}
                  />
                </>
              ),
            },
          ]}
        />
      </Modal>
    </>
  );
};

export default ApprovalSection;
