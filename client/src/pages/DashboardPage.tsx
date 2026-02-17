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
  Steps,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  ForwardOutlined,
} from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { fetchStatus } from '../store/statusSlice';
import { fetchConfig } from '../store/configSlice';
import ManualTrigger from '../components/dashboard/ManualTrigger';
import { snakeToCamel } from '../utils/i18n-helpers';

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

// Map state keys to localized analysis reason i18n keys.
// The backend returns English reason strings; the frontend uses these
// i18n keys instead so that the dashboard displays in the user's locale.
const STATE_REASON_MAP: Record<string, string> = {
  not_checked_in: 'analysis.notCheckedIn',
  working: 'analysis.working',
  on_break: 'analysis.onBreak',
  checked_out: 'analysis.checkedOut',
  holiday: 'analysis.holiday',
  disabled: 'analysis.disabled',
  unknown: 'analysis.unknown',
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
  trigger_type?: string;
  duration?: number | string;
  company_name?: string;
  company_id?: string;
}

interface PunchTime {
  type: string;   // 'checkin' | 'break_start' | 'break_end' | 'checkout'
  time: string;   // 'HH:MM'
  datetime: string;
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

  // Fetch status and config on mount, visibility-aware auto-refresh every 30 seconds.
  // Pauses polling when the browser tab is hidden to save resources (Plan E optimization).
  useEffect(() => {
    dispatch(fetchConfig());
    loadStatus();
    let interval: ReturnType<typeof setInterval> | null = setInterval(loadStatus, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Tab hidden → stop polling
        if (interval) { clearInterval(interval); interval = null; }
      } else {
        // Tab visible → refresh immediately + restart polling
        loadStatus();
        if (!interval) { interval = setInterval(loadStatus, 30000); }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [dispatch, loadStatus]);

  // Browser mode disabled — only check OAuth credentials
  const hasCredentials = oauthConfigured;

  // Derive actual state: prefer freee time_clocks data, fall back to startup_analysis
  const punchTimesRaw: PunchTime[] = statusData?.today_punch_times || [];
  const derivedState = (() => {
    if (punchTimesRaw.length > 0) {
      const lastType = punchTimesRaw[punchTimesRaw.length - 1].type;
      if (lastType === 'checkout') return 'checked_out';
      if (lastType === 'break_start') return 'on_break';
      if (lastType === 'break_end' || lastType === 'checkin') return 'working';
    }
    return statusData?.startup_analysis?.state || 'unknown';
  })();
  const detectedState = derivedState;
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
      render: (val: string) => t(`actions.${snakeToCamel(val || '')}`),
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
      dataIndex: 'trigger_type',
      key: 'trigger',
      render: (val: string) => (
        <Tag bordered={false}>{t(`status.${val || 'unknown'}`)}</Tag>
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

            {/* Analysis reason — use localized i18n string based on state */}
            {statusData.startup_analysis?.state && (
              <Text type="secondary" style={{ display: 'block' }}>
                {t(STATE_REASON_MAP[statusData.startup_analysis.state] || 'analysis.unknown')}
                {statusData.startup_analysis.retrying && (
                  <Text type="warning" style={{ marginLeft: 8 }}>
                    ({t('analysis.retrying', {
                      attempt: statusData.startup_analysis.retryAttempt,
                      max: statusData.startup_analysis.retryMax,
                    })})
                  </Text>
                )}
              </Text>
            )}

            {/* Next action info */}
            {statusData.next_action ? (
              <Alert
                message={
                  statusData.next_action.mode === 'random'
                    ? t('dashboard.nextActionRandom', {
                        action: t(`actions.${snakeToCamel(statusData.next_action.action_type || '')}`),
                        start: statusData.next_action.window_start,
                        end: statusData.next_action.window_end,
                      })
                    : t('dashboard.nextAction', {
                        action: t(`actions.${snakeToCamel(statusData.next_action.action_type || '')}`),
                        time: statusData.next_action.time,
                      })
                }
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
                  <div>
                    <Text type="secondary" style={{ fontSize: 14 }}>
                      {t('dashboard.todayLog')}
                    </Text>
                    <div style={{ fontSize: 24, fontWeight: 600 }}>
                      {statusData.today_logs.length}
                    </div>
                  </div>
                </Col>
              </Row>
            )}
          </Space>
        ) : null}
      </Card>

      {/* Today's punch progress */}
      {statusData && (() => {
        const isHoliday = statusData.is_holiday;
        const isDisabled = detectedState === 'disabled';
        const skippedSet = new Set<string>(statusData.skipped_actions || []);
        const punchTimes: PunchTime[] = punchTimesRaw;

        if (isHoliday || isDisabled) {
          return (
            <Card size="small">
              <Text type="secondary">
                {isHoliday ? t('analysis.holiday') : t('analysis.disabled')}
              </Text>
            </Card>
          );
        }

        // Build log map for fallback (mock mode / no freee time_clocks)
        const logs: LogEntry[] = statusData.today_logs || [];
        const logMap: Record<string, LogEntry> = {};
        for (const log of logs) {
          const at = log.action_type || '';
          if (!logMap[at] || log.status === 'success') {
            logMap[at] = log;
          }
        }

        // When freee time_clocks data is available, use it as primary source.
        // Otherwise fall back to logs + detected state (mock mode, API unavailable).
        const hasPunchData = punchTimes.length > 0;

        // Build dynamic step list
        const punchSteps: string[] = hasPunchData
          ? punchTimes.map(pt => pt.type)                     // from freee records
          : ['checkin', 'break_start', 'break_end', 'checkout']; // default 4-step

        // Append pending steps based on current state
        if (hasPunchData) {
          const lastType = punchTimes[punchTimes.length - 1].type;
          if (detectedState === 'working' || lastType === 'break_end' || lastType === 'checkin') {
            punchSteps.push('checkout');
          } else if (detectedState === 'on_break' || lastType === 'break_start') {
            punchSteps.push('break_end', 'checkout');
          }
          // checked_out → nothing to append
        }

        // Determine completed steps
        // With freee data: completed = index < punchTimes.length (1:1 mapping)
        // Without freee data: infer from logs + state (fallback)
        const completedByState = new Set<string>();
        if (!hasPunchData) {
          if (['working', 'on_break', 'checked_out'].includes(detectedState)) completedByState.add('checkin');
          if (['on_break', 'checked_out'].includes(detectedState)) completedByState.add('break_start');
          if (detectedState === 'checked_out') { completedByState.add('break_end'); completedByState.add('checkout'); }
          if (logMap['checkout']?.status === 'success') { completedByState.add('checkin'); completedByState.add('break_start'); completedByState.add('break_end'); }
          if (logMap['break_end']?.status === 'success') { completedByState.add('checkin'); completedByState.add('break_start'); }
          if (logMap['break_start']?.status === 'success') { completedByState.add('checkin'); }
        }

        const isStepDone = (step: string, i: number) => {
          if (hasPunchData) return i < punchTimes.length;
          return logMap[step]?.status === 'success' || completedByState.has(step);
        };

        // Check if ANY step has actual evidence of completion (log/state)
        // If so, remaining skips are stale (user intervened manually)
        const hasAnyEvidence = punchSteps.some((s) => logMap[s]?.status === 'success' || completedByState.has(s));
        // If no evidence at all and everything skipped, treat skips as final
        const allSkippedNoEvidence = !hasAnyEvidence && skippedSet.size >= 4;

        let currentStep = 0;
        for (let i = 0; i < punchSteps.length; i++) {
          const step = punchSteps[i];
          const done = isStepDone(step, i);
          const isSkipFinal = allSkippedNoEvidence && skippedSet.has(step);
          if (done || isSkipFinal) currentStep = i + 1;
          else break;
        }

        return (
          <Card
            title={<Title level={5} style={{ margin: 0 }}>{t('dashboard.punchProgress')}</Title>}
            size="small"
          >
            <Steps
              current={currentStep}
              size="small"
              items={punchSteps.map((step, i) => {
                const done = isStepDone(step, i);
                const freeTime = hasPunchData && i < punchTimes.length ? punchTimes[i].time : undefined;
                const log = logMap[step];
                // Only show skip icon when ALL steps were skipped with no manual intervention
                const isSkipped = allSkippedNoEvidence && !done && skippedSet.has(step);

                // Step label: append number when the same type appears more than once
                const sameTypeBefore = punchSteps.slice(0, i).filter(s => s === step).length;
                const sameTypeTotal = punchSteps.filter(s => s === step).length;
                const needsNumber = sameTypeTotal > 1 && ['break_start', 'break_end'].includes(step);
                const title = t(`actions.${snakeToCamel(step)}`) + (needsNumber ? ` ${sameTypeBefore + 1}` : '');

                let status: 'wait' | 'process' | 'finish' | 'error' = done ? 'finish' : 'wait';
                let icon: React.ReactNode | undefined;
                let description: string | undefined;

                if (freeTime) {
                  description = freeTime;
                } else if (done && log?.status === 'success') {
                  const time = log.executed_at?.split(' ')[1];
                  description = time || undefined;
                } else if (!done && log?.status === 'failure') {
                  status = 'error';
                  const time = log.executed_at?.split(' ')[1];
                  description = time || undefined;
                } else if (done && completedByState.has(step) && !skippedSet.has(step)) {
                  description = t('status.detected');
                }

                if (isSkipped) {
                  status = 'finish';
                  icon = <ForwardOutlined style={{ color: '#faad14' }} />;
                  description = t('status.skipped');
                }

                // Current in-progress step
                if (!done && !isSkipped && i === currentStep) {
                  status = 'process';
                }

                return { title, status, description, icon };
              })}
            />
          </Card>
        );
      })()}

      {/* Manual trigger */}
      <ManualTrigger onActionComplete={loadStatus} />

      {/* Today's log table */}
      <Card title={
        <Space>
          <Title level={5} style={{ margin: 0 }}>{t('dashboard.todayLog')}</Title>
          {(() => {
            const companyName = statusData?.today_logs?.find((l: LogEntry) => l.company_name)?.company_name;
            return companyName ? <Tag color="blue" style={{ fontSize: 11 }}>{companyName}</Tag> : null;
          })()}
        </Space>
      }>
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
