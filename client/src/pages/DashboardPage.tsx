import React, { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Table,
  Alert,
  Tag,
  Typography,
  Space,
  Spin,
  Row,
  Col,
  Statistic,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { fetchStatus } from '../store/statusSlice';
import { fetchConfig } from '../store/configSlice';
import ManualTrigger from '../components/dashboard/ManualTrigger';

const { Title, Text } = Typography;

// Color mapping for the detected freee state
const STATE_COLORS: Record<string, string> = {
  not_checked_in: '#faad14',
  working: '#52c41a',
  on_break: '#1677ff',
  checked_out: '#8c8c8c',
  holiday: '#722ed1',
  disabled: '#d9d9d9',
  unknown: '#ff4d4f',
};

// Map state keys to i18n label keys
const STATE_LABEL_MAP: Record<string, string> = {
  not_checked_in: 'manualTrigger.stateNotCheckedIn',
  working: 'manualTrigger.stateWorking',
  on_break: 'manualTrigger.stateOnBreak',
  checked_out: 'manualTrigger.stateCheckedOut',
  holiday: 'header.holiday',
  disabled: 'analysis.disabled',
  unknown: 'manualTrigger.stateUnknown',
};

// Color mapping for log entry status
const LOG_STATUS_COLORS: Record<string, string> = {
  success: '#52c41a',
  failure: '#ff4d4f',
  skipped: '#faad14',
};

interface LogEntry {
  executed_at?: string;
  action_type?: string;
  status?: string;
  trigger?: string;
  duration?: number | string;
}

const DashboardPage: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { data: statusData, loading } = useAppSelector((state) => state.status);
  const {
    autoEnabled,
    debugMode,
    oauthConfigured,
  } = useAppSelector((state) => state.config);

  const loadStatus = useCallback(() => {
    dispatch(fetchStatus());
  }, [dispatch]);

  // Fetch status and config on mount, auto-refresh every 30 seconds
  useEffect(() => {
    dispatch(fetchConfig());
    loadStatus();
    const interval = setInterval(loadStatus, 30000);
    return () => clearInterval(interval);
  }, [dispatch, loadStatus]);

  // Browser mode disabled — only check OAuth credentials
  const hasCredentials = oauthConfigured;

  // Build the state tag color from startup_analysis.state
  const detectedState = statusData?.startup_analysis?.state || 'unknown';
  const stateColor = STATE_COLORS[detectedState] || STATE_COLORS.unknown;

  // Table columns for today's log
  const columns: ColumnsType<LogEntry> = [
    {
      title: t('table.time'),
      dataIndex: 'executed_at',
      key: 'time',
      render: (val: string) => val?.split(' ')[1] || val || '-',
    },
    {
      title: t('table.action'),
      dataIndex: 'action_type',
      key: 'action',
      render: (val: string) => t(`actions.${val?.replace('_', '')}`),
    },
    {
      title: t('table.status'),
      dataIndex: 'status',
      key: 'status',
      render: (val: string) => {
        const color = LOG_STATUS_COLORS[val] || '#8c8c8c';
        return (
          <Tag color={color} style={{ fontWeight: 600 }}>
            {t(`status.${val}`)}
          </Tag>
        );
      },
    },
    {
      title: t('table.trigger'),
      dataIndex: 'trigger',
      key: 'trigger',
      render: (val: string) => (
        <Tag bordered={false}>{t(`status.${val}`)}</Tag>
      ),
    },
    {
      title: t('table.duration'),
      dataIndex: 'duration',
      key: 'duration',
      render: (val: number | string | undefined) => (val != null ? String(val) : '-'),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* Credential warning alert */}
      {!hasCredentials && !debugMode && (
        <Alert
          message={t('dashboard.credentialWarning')}
          type="warning"
          showIcon
          icon={<WarningOutlined />}
        />
      )}

      {/* Auto-scheduling disabled alert */}
      {!autoEnabled && (
        <Alert
          message={t('dashboard.autoOff')}
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
        />
      )}

      {/* Status card */}
      <Card title={<Title level={5} style={{ margin: 0 }}>{t('dashboard.startupAnalysis')}</Title>}>
        {loading && !statusData ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
            <Spin size="large" />
          </div>
        ) : statusData ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* Detected state row */}
            <Row gutter={[16, 16]} align="middle">
              <Col>
                <Text type="secondary">{t('dashboard.detectedState')}:</Text>
              </Col>
              <Col>
                <Tag color={stateColor} style={{ fontWeight: 600 }}>
                  {t(STATE_LABEL_MAP[detectedState] || 'manualTrigger.stateUnknown')}
                </Tag>
              </Col>
            </Row>

            {/* Analysis reason */}
            {statusData.startup_analysis?.reason && (
              <Text type="secondary" style={{ display: 'block' }}>
                {statusData.startup_analysis.reason}
              </Text>
            )}

            {/* Next action info */}
            {statusData.next_action ? (
              <Alert
                message={t('dashboard.nextAction', {
                  action: t(`actions.${statusData.next_action.action_type?.replace('_', '')}`),
                  time: statusData.next_action.time,
                })}
                type="info"
                showIcon
                icon={<ClockCircleOutlined />}
              />
            ) : (
              <Alert
                message={t('dashboard.allDone')}
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
              />
            )}

            {/* Statistics row */}
            {statusData.today_logs && (
              <Row gutter={16}>
                <Col span={8}>
                  <Statistic
                    title={t('table.action')}
                    value={statusData.today_logs.length}
                    suffix={t('dashboard.todayLog')}
                  />
                </Col>
              </Row>
            )}
          </Space>
        ) : null}
      </Card>

      {/* Manual trigger */}
      <ManualTrigger onActionComplete={loadStatus} />

      {/* Today's log table */}
      <Card title={<Title level={5} style={{ margin: 0 }}>{t('dashboard.todayLog')}</Title>}>
        <Table<LogEntry>
          columns={columns}
          dataSource={statusData?.today_logs || []}
          rowKey={(_, index) => String(index)}
          size="small"
          pagination={false}
          locale={{ emptyText: t('dashboard.noActions') }}
        />
      </Card>
    </Space>
  );
};

export default DashboardPage;
