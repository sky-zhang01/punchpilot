import React, { useEffect, useReducer, useRef, useState } from 'react';
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
import type { ApprovalActionRequest, ApprovalMutationContext } from '../../api';
import { useAppSelector } from '../../store/hooks';
import { notifySuccess, notifyError } from '../../utils/notify';
import TaskRecoveryPanel from './TaskRecoveryPanel';
import { getTaskSnapshots, subscribeTasks } from '../../tasks';

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
  approval_context?: ApprovalMutationContext;
}

const APPROVAL_VERSION_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;

function isApprovalMutationContext(value: unknown): value is ApprovalMutationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Partial<ApprovalMutationContext>;
  return Number.isSafeInteger(context.current_round) &&
    Number(context.current_round) >= 0 &&
    Number.isSafeInteger(context.current_step_id) &&
    Number(context.current_step_id) > 0 &&
    typeof context.request_version === 'string' &&
    APPROVAL_VERSION_PATTERN.test(context.request_version);
}

function approvalActionRequest(
  record: IncomingRequest,
  action: 'approve' | 'feedback',
): ApprovalActionRequest | null {
  if (!isApprovalMutationContext(record.approval_context)) return null;
  return {
    id: record.id,
    type: record.type,
    action,
    expected: record.approval_context,
  };
}

function isSuccessfulSingleAction(data: any): boolean {
  return data?.success === true &&
    data?.total === 1 &&
    data?.succeeded === 1 &&
    data?.failed === 0 &&
    Array.isArray(data?.results) &&
    data.results.length === 1 &&
    data.results[0]?.success === true;
}

function approvalKey(request: Pick<ApprovalRequest, 'id' | 'type'>): string {
  return `${request.type}:${request.id}`;
}

/**
 * ApprovalSection — Monthly closing + View/Withdraw approval requests + Incoming requests.
 *
 * Features:
 * - Monthly closing submission
 * - My requests: view, batch withdraw
 * - Incoming requests: view, batch approve/reject
 *
 * Monthly closing can use OAuth or stored Web credentials. Request tracking
 * and approval actions remain OAuth-only.
 */
const ApprovalSection: React.FC = () => {
  const { t } = useTranslation();
  const identity = useAppSelector((state) => state.identity);
  const { year, month } = useAppSelector((state) => state.attendance);
  const { webCredentialsConfigured, oauthConfigured } = useAppSelector((state) => state.config);
  const capabilities = useAppSelector((state) => state.attendance.capabilities);
  const oauthApprovalAvailable = oauthConfigured && (!capabilities || capabilities.approval);
  const monthlyClosingAvailable = webCredentialsConfigured || oauthApprovalAvailable;

  // Monthly closing
  const [closingLoading, setClosingLoading] = useState(false);
  const [closingConfirm, setClosingConfirm] = useState(false);
  const [closingTarget, setClosingTarget] = useState<{ year: number; month: number } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  // Approval requests list (my requests)
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsComplete, setRequestsComplete] = useState(true);
  const [withdrawingKey, setWithdrawingKey] = useState<string | null>(null);
  const [selectedMyKeys, setSelectedMyKeys] = useState<string[]>([]);
  const [batchWithdrawLoading, setBatchWithdrawLoading] = useState(false);

  // Incoming requests (for approval)
  const [incomingRequests, setIncomingRequests] = useState<IncomingRequest[]>([]);
  const [incomingLoading, setIncomingLoading] = useState(false);
  const [incomingComplete, setIncomingComplete] = useState(true);
  const [selectedIncomingKeys, setSelectedIncomingKeys] = useState<string[]>([]);
  const [batchApproveLoading, setBatchApproveLoading] = useState(false);

  // Active tab in modal
  const [activeTab, setActiveTab] = useState('my');
  const requestsGeneration = useRef(0);
  const incomingGeneration = useRef(0);
  const [admissionUnknownKeys, setAdmissionUnknownKeys] = useState<string[]>([]);
  const [submittedTasks, setSubmittedTasks] = useState<Record<string, string[]>>({});
  const [, refreshTasks] = useReducer(value => value + 1, 0);
  useEffect(() => subscribeTasks(refreshTasks), []);
  useEffect(() => { setSubmittedTasks({}); setAdmissionUnknownKeys([]); }, [identity]);
  const blockedKeys = new Set([...admissionUnknownKeys, ...Object.entries(submittedTasks).flatMap(([taskId, keys]) => {
    const task = getTaskSnapshots().find(value => value.taskId === taskId);
    if (!task || task.status === 'running') return keys;
    return task.results.filter(result => result.unknown).map(result => `${result.type}:${result.id}`);
  })]);
  const requestBusy = batchWithdrawLoading || batchApproveLoading || withdrawingKey !== null;
  const trackTask = (taskId: string, keys: string[]) => setSubmittedTasks(value => ({ ...value, [taskId]: keys }));


  useEffect(() => {
    requestsGeneration.current += 1;
    incomingGeneration.current += 1;
    setRequestsLoading(false);
    setIncomingLoading(false);
    setPlanError(null);
    setClosingConfirm(false);
    setClosingTarget(null);
    setRequestsOpen(false);
    setSelectedMyKeys([]);
    setSelectedIncomingKeys([]);
    setRequests([]);
    setIncomingRequests([]);
  }, [year, month, identity]);

  if (!monthlyClosingAvailable && !oauthApprovalAvailable) return null;

  const handleMonthlyClosing = async () => {
    if (!closingTarget) return;
    setClosingLoading(true);
    setPlanError(null);
    try {
      await api.submitMonthlyAttendance(closingTarget);
      notifySuccess(t('calendar.approvalSubmitted'));
      setClosingConfirm(false);
      setClosingTarget(null);
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
    const generation = ++requestsGeneration.current;
    setRequestsLoading(true);
    try {
      const res = await api.getApprovalRequests(year, month);
      if (generation !== requestsGeneration.current) return;
      setRequests(res.data.requests || []);
      setRequestsComplete(res.data.complete !== false);
    } catch (err: any) {
      if (generation !== requestsGeneration.current) return;
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : err?.taskId ? t('tasks.queryPaused') : err?.response?.data?.error || t('common.error'));
      setRequests([]);
      setRequestsComplete(false);
    } finally {
      if (generation === requestsGeneration.current) setRequestsLoading(false);
    }
  };

  // --- Incoming Requests ---
  const loadIncomingRequests = async () => {
    const generation = ++incomingGeneration.current;
    setIncomingLoading(true);
    try {
      const res = await api.getIncomingRequests(year, month);
      if (generation !== incomingGeneration.current) return;
      setIncomingRequests(res.data.requests || []);
      setIncomingComplete(res.data.complete !== false);
    } catch (err: any) {
      if (generation !== incomingGeneration.current) return;
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : err?.taskId ? t('tasks.queryPaused') : err?.response?.data?.error || t('common.error'));
      setIncomingRequests([]);
      setIncomingComplete(false);
    } finally {
      if (generation === incomingGeneration.current) setIncomingLoading(false);
    }
  };

  const handleOpenRequests = () => {
    setRequestsOpen(true);
    setSelectedMyKeys([]);
    setSelectedIncomingKeys([]);
    loadRequests();
    loadIncomingRequests();
  };

  const handleWithdraw = async (record: ApprovalRequest) => {
    setWithdrawingKey(approvalKey(record));
    try {
      await api.withdrawApprovalRequest(record.id, record.type);
      notifySuccess(t('calendar.withdrawSuccess'));
      loadRequests();
    } catch (err: any) {
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : err?.taskId ? t('tasks.queryPaused') : err?.response?.data?.error || t('calendar.withdrawFailed'));
    } finally {
      setWithdrawingKey(null);
    }
  };

  // Batch withdraw selected requests
  const handleBatchWithdraw = async () => {
    const toWithdraw = requests
      .filter(r => selectedMyKeys.includes(approvalKey(r)) && (r.status === 'in_progress' || r.status === 'draft'))
      .map(r => ({ id: r.id, type: r.type }));

    if (toWithdraw.length === 0) {
      notifyError(t('calendar.noWithdrawable'));
      return;
    }

    setSelectedMyKeys([]);
    setBatchWithdrawLoading(true);
    try {
      const res = await api.batchWithdrawRequests({ requests: toWithdraw });
      const data = res.data;
      if (data.unknown > 0) trackTask(data.taskId, toWithdraw.map(approvalKey));
      if (!data.success) {
        notifyError(`${data.succeeded}/${toWithdraw.length} ${t('calendar.withdrawSuccess')}, ${data.failed} ${t('calendar.withdrawFailed')}`);
      } else {
        notifySuccess(`${data.succeeded} ${t('calendar.withdrawSuccess')}`);
      }
      setSelectedMyKeys(keys => keys.filter(key => !data.results.some((result: { id?: number; type?: string }) => `${result.type}:${result.id}` === key)));
      loadRequests();
    } catch (err: any) {
      if (err?.taskId) trackTask(err.taskId, toWithdraw.map(approvalKey));
      if (err?.code === 'TASK_ADMISSION_UNKNOWN') setAdmissionUnknownKeys(keys => [...keys, ...toWithdraw.map(approvalKey)]);
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : err?.taskId ? t('tasks.queryPaused') : err?.response?.data?.error || t('calendar.withdrawFailed'));
    } finally {
      setBatchWithdrawLoading(false);
    }
  };

  // Batch approve or reject incoming requests
  const handleBatchApproveAction = async (action: 'approve' | 'feedback') => {
    const selectedRecords = incomingRequests
      .filter(r => selectedIncomingKeys.includes(approvalKey(r)));
    if (selectedRecords.length === 0) return;
    const selected: ApprovalActionRequest[] = [];
    for (const record of selectedRecords) {
      const request = approvalActionRequest(record, action);
      if (!request) {
        notifyError(t('common.error'));
        return;
      }
      selected.push(request);
    }

    setSelectedIncomingKeys([]);
    setBatchApproveLoading(true);
    try {
      const res = await api.batchApproveRequests({ requests: selected });
      const data = res.data;
      if (data.unknown > 0) trackTask(data.taskId, selected.map(approvalKey));
      const actionLabel = action === 'approve' ? t('calendar.approved') : t('calendar.rejected');
      if (!data.success) {
        notifyError(`${data.succeeded}/${selected.length} ${actionLabel}, ${data.failed} ${t('common.failed')}`);
      } else {
        notifySuccess(`${data.succeeded} ${actionLabel}`);
      }
      setSelectedIncomingKeys(keys => keys.filter(key => !data.results.some((result: { id?: number; type?: string }) => `${result.type}:${result.id}` === key)));
      loadIncomingRequests();
    } catch (err: any) {
      if (err?.taskId) trackTask(err.taskId, selected.map(approvalKey));
      if (err?.code === 'TASK_ADMISSION_UNKNOWN') setAdmissionUnknownKeys(keys => [...keys, ...selected.map(approvalKey)]);
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : err?.taskId ? t('tasks.queryPaused') : err?.response?.data?.error || t('common.error'));
    } finally {
      setBatchApproveLoading(false);
    }
  };

  const handleIncomingAction = async (
    record: IncomingRequest,
    action: 'approve' | 'feedback',
  ) => {
    const actionLabel = action === 'approve' ? t('calendar.approved') : t('calendar.rejected');
    const request = approvalActionRequest(record, action);
    if (!request) {
      notifyError(t('common.error'));
      return;
    }
    setBatchApproveLoading(true);
    try {
      const res = await api.batchApproveRequests({
        requests: [request],
      });
      if (res.data.unknown > 0) trackTask(res.data.taskId, [approvalKey(record)]);
      if (isSuccessfulSingleAction(res.data)) {
        notifySuccess(actionLabel);
      } else {
        notifyError(`${actionLabel}: ${t('common.failed')}`);
      }
    } catch (err: any) {
      if (err?.taskId) trackTask(err.taskId, [approvalKey(record)]);
      if (err?.code === 'TASK_ADMISSION_UNKNOWN') setAdmissionUnknownKeys(keys => [...keys, approvalKey(record)]);
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : err?.taskId ? t('tasks.queryPaused') : err?.response?.data?.error || t('common.error'));
    } finally {
      setBatchApproveLoading(false);
      loadIncomingRequests();
    }
  };

  // --- My Requests Table ---
  const withdrawableKeys = requests
    .filter(r => !blockedKeys.has(approvalKey(r)) && (r.status === 'in_progress' || r.status === 'draft'))
    .map(approvalKey);

  const myRequestColumns: ColumnsType<ApprovalRequest> = [
    {
      title: (
        <Checkbox
          checked={withdrawableKeys.length > 0 && withdrawableKeys.every(key => selectedMyKeys.includes(key))}
          indeterminate={selectedMyKeys.length > 0 && selectedMyKeys.length < withdrawableKeys.length}
          onChange={(e) => setSelectedMyKeys(e.target.checked ? withdrawableKeys : [])}
          disabled={requestBusy || withdrawableKeys.length === 0}
        />
      ),
      key: 'select',
      width: 40,
      render: (_: any, record: ApprovalRequest) => {
        const canSelect = !requestBusy && !blockedKeys.has(approvalKey(record)) && (record.status === 'in_progress' || record.status === 'draft');
        if (!canSelect) return null;
        return (
          <Checkbox
            checked={selectedMyKeys.includes(approvalKey(record))}
            onChange={(e) => {
              const key = approvalKey(record);
              setSelectedMyKeys(prev =>
                e.target.checked ? [...prev, key] : prev.filter(value => value !== key)
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
        const canWithdraw = !requestBusy && !blockedKeys.has(approvalKey(record)) && (record.status === 'in_progress' || record.status === 'draft');
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
              loading={withdrawingKey === approvalKey(record)}
            >
              {t('calendar.withdrawApproval')}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  // --- Incoming Requests Table ---
  const actionableIncomingKeys = incomingRequests
    .filter(r => !blockedKeys.has(approvalKey(r)) && isApprovalMutationContext(r.approval_context))
    .map(approvalKey);

  const incomingColumns: ColumnsType<IncomingRequest> = [
    {
      title: (
        <Checkbox
          checked={actionableIncomingKeys.length > 0 && actionableIncomingKeys.every(key => selectedIncomingKeys.includes(key))}
          indeterminate={selectedIncomingKeys.length > 0 && selectedIncomingKeys.length < actionableIncomingKeys.length}
          onChange={(e) => setSelectedIncomingKeys(e.target.checked ? actionableIncomingKeys : [])}
          disabled={requestBusy || actionableIncomingKeys.length === 0}
        />
      ),
      key: 'select',
      width: 40,
      render: (_: any, record: IncomingRequest) => {
        const actionable = !requestBusy && !blockedKeys.has(approvalKey(record)) && isApprovalMutationContext(record.approval_context);
        return (
          <Checkbox
            checked={selectedIncomingKeys.includes(approvalKey(record))}
            disabled={!actionable}
            onChange={(e) => {
              const key = approvalKey(record);
              setSelectedIncomingKeys(prev =>
                e.target.checked ? [...prev, key] : prev.filter(value => value !== key)
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
      render: (_: any, record: IncomingRequest) => {
        const actionable = !requestBusy && !blockedKeys.has(approvalKey(record)) && isApprovalMutationContext(record.approval_context);
        return (
          <Space size="small">
            <Popconfirm
              title={t('calendar.approveConfirm')}
              onConfirm={() => handleIncomingAction(record, 'approve')}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button
                type="link"
                size="small"
                icon={<CheckCircleOutlined />}
                style={{ color: '#52c41a' }}
                disabled={!actionable}
              >
                {t('calendar.approve')}
              </Button>
            </Popconfirm>
            <Popconfirm
              title={t('calendar.rejectConfirm')}
              onConfirm={() => handleIncomingAction(record, 'feedback')}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button type="link" danger size="small" icon={<CloseCircleOutlined />} disabled={!actionable}>
                {t('calendar.reject')}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <>
      {planError && (
        <Alert type="warning" showIcon message={planError} style={{ marginBottom: 8 }} closable onClose={() => setPlanError(null)} />
      )}

      <Space wrap size="small">
        {monthlyClosingAvailable && (
          <Button
            icon={<SendOutlined />}
            size="small"
            onClick={() => {
              setClosingTarget({ year, month });
              setClosingConfirm(true);
            }}
          >
            {t('calendar.monthlyClosing')}
          </Button>
        )}
        {oauthApprovalAvailable && (
          <Button
            icon={<UnorderedListOutlined />}
            size="small"
            onClick={handleOpenRequests}
          >
            {t('calendar.viewRequests')}
          </Button>
        )}
        {monthlyClosingAvailable && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('calendar.monthlyClosingDesc')}
          </Text>
        )}
      </Space>

      {/* Monthly closing confirmation modal */}
      {monthlyClosingAvailable && (
        <Modal
          title={t('calendar.monthlyClosing')}
          open={closingConfirm}
          onCancel={() => {
            setClosingConfirm(false);
            setClosingTarget(null);
          }}
          onOk={handleMonthlyClosing}
          confirmLoading={closingLoading}
          okText={t('calendar.batchSubmit')}
          cancelText={t('calendar.batchCancel')}
        >
          <Text>
            {t('calendar.monthlyClosingDesc')} ({closingTarget?.year}-{String(closingTarget?.month || '').padStart(2, '0')})
          </Text>
        </Modal>
      )}

      {/* Approval requests modal with tabs */}
      {oauthApprovalAvailable && <Modal
        title={t('calendar.approvalRequests')}
        open={requestsOpen}
        onCancel={() => setRequestsOpen(false)}
        footer={null}
        width={800}
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          {year}-{String(month).padStart(2, '0')}
        </Text>

        {admissionUnknownKeys.length > 0 && <Alert type="warning" showIcon message={t('tasks.admissionUnknown')} />}
        {requestsOpen && <TaskRecoveryPanel />}
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
                  {!requestsComplete && (
                    <Alert
                      type="warning"
                      showIcon
                      message={t('calendar.approvalListIncomplete')}
                      style={{ marginBottom: 8 }}
                    />
                  )}
                  {selectedMyKeys.length > 0 && (
                    <Space style={{ marginBottom: 8 }}>
                      <Text type="secondary">
                        {t('calendar.selectedCount', { count: selectedMyKeys.length })}
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
                    rowKey={approvalKey}
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
                  {!incomingComplete && (
                    <Alert
                      type="warning"
                      showIcon
                      message={t('calendar.approvalListIncomplete')}
                      style={{ marginBottom: 8 }}
                    />
                  )}
                  {selectedIncomingKeys.length > 0 && (
                    <Space style={{ marginBottom: 8 }}>
                      <Text type="secondary">
                        {t('calendar.selectedCount', { count: selectedIncomingKeys.length })}
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
                    rowKey={approvalKey}
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
      </Modal>}
    </>
  );
};

export default ApprovalSection;
