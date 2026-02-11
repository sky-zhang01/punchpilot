import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Table,
  DatePicker,
  Input,
  Button,
  Select,
  Tag,
  Typography,
  Space,
  Modal,
  Pagination,
} from 'antd';
import {
  SearchOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../api';

const { RangePicker } = DatePicker;
const { Text } = Typography;

// Color mapping for status tags
const STATUS_TAG_CONFIG: Record<string, { color: string }> = {
  success: { color: 'success' },
  failure: { color: 'error' },
  skipped: { color: 'warning' },
};

// Color mapping for action tags
const ACTION_TAG_CONFIG: Record<string, { color: string }> = {
  checkin: { color: 'green' },
  checkout: { color: 'blue' },
  break_start: { color: 'orange' },
  break_end: { color: 'cyan' },
  batch_correction: { color: 'purple' },
  approval_submitted: { color: 'geekblue' },
  monthly_closing: { color: 'magenta' },
};

const LogsPage: React.FC = () => {
  const { t } = useTranslation();

  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Filters
  const [dateRange, setDateRange] = useState<
    [dayjs.Dayjs | null, dayjs.Dayjs | null] | null
  >(null);
  const [actionFilter, setActionFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchText, setSearchText] = useState('');

  // Detail modal
  const [detailLog, setDetailLog] = useState<any>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = {
        page,
        limit: pageSize,
      };
      if (dateRange && dateRange[0]) {
        params.date_from = dateRange[0].format('YYYY-MM-DD');
      }
      if (dateRange && dateRange[1]) {
        params.date_to = dateRange[1].format('YYYY-MM-DD');
      }
      if (actionFilter) params.action_type = actionFilter;
      if (statusFilter) params.status = statusFilter;
      if (searchText) params.search = searchText;

      const res = await api.getLogs(params);
      setLogs(res.data.rows || res.data.logs || []);
      setTotal(res.data.total || 0);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, dateRange, actionFilter, statusFilter, searchText]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const openDetail = async (logId: number) => {
    try {
      const res = await api.getLogDetail(logId);
      setDetailLog(res.data);
      setDetailOpen(true);
    } catch {
      // silently fail
    }
  };

  // Reset page when filters change
  const handleFilterChange = () => {
    setPage(1);
  };

  const columns: ColumnsType<any> = [
    {
      title: t('table.date'),
      dataIndex: 'executed_at',
      key: 'date',
      render: (val: string) => (val ? dayjs(val).format('YYYY-MM-DD') : '-'),
      width: 120,
    },
    {
      title: t('table.time'),
      dataIndex: 'executed_at',
      key: 'time',
      render: (val: string) => (val ? dayjs(val).format('HH:mm:ss') : '-'),
      width: 100,
    },
    {
      title: t('table.action'),
      dataIndex: 'action_type',
      key: 'action',
      render: (val: string) => {
        const tagConfig = ACTION_TAG_CONFIG[val] || { color: 'default' };
        // Map action_type to i18n key (camelCase)
        const i18nKeyMap: Record<string, string> = {
          checkin: 'checkin',
          checkout: 'checkout',
          break_start: 'breakStart',
          break_end: 'breakEnd',
          batch_correction: 'batchCorrection',
          approval_submitted: 'approvalSubmitted',
          monthly_closing: 'monthlyClosing',
        };
        const i18nKey = i18nKeyMap[val] || val?.replace('_', '');
        return (
          <Tag color={tagConfig.color}>
            {t(`actions.${i18nKey}`)}
          </Tag>
        );
      },
      width: 130,
    },
    {
      title: t('table.status'),
      dataIndex: 'status',
      key: 'status',
      render: (val: string) => {
        const tagConfig = STATUS_TAG_CONFIG[val] || { color: 'default' };
        return <Tag color={tagConfig.color}>{t(`status.${val}`)}</Tag>;
      },
      width: 100,
    },
    {
      title: t('table.company'),
      dataIndex: 'company_name',
      key: 'company',
      render: (val: string) => val || '-',
      width: 130,
    },
    {
      title: t('table.trigger'),
      dataIndex: 'trigger_type',
      key: 'trigger',
      render: (val: string) => (
        <Tag bordered={false}>{t(`status.${val}`)}</Tag>
      ),
      width: 100,
    },
    {
      title: t('table.duration'),
      dataIndex: 'duration_ms',
      key: 'duration',
      render: (val: number) => (val ? `${val}ms` : '-'),
      width: 100,
    },
    {
      title: t('table.actions'),
      key: 'detail',
      render: (_: any, record: any) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => openDetail(record.id)}
        >
          {t('table.view')}
        </Button>
      ),
      width: 100,
    },
  ];

  return (
    <div>
      {/* Filters */}
      <Space wrap style={{ marginBottom: 16 }}>
        <RangePicker
          value={dateRange}
          onChange={(dates) => {
            setDateRange(dates);
            handleFilterChange();
          }}
          allowClear
          style={{ width: 280 }}
        />
        <Select
          value={actionFilter}
          onChange={(val) => {
            setActionFilter(val);
            handleFilterChange();
          }}
          style={{ width: 160 }}
          placeholder={t('logs.actionFilter')}
          allowClear
          onClear={() => {
            setActionFilter('');
            handleFilterChange();
          }}
          options={[
            { label: t('logs.all'), value: '' },
            { label: t('actions.checkin'), value: 'checkin' },
            { label: t('actions.checkout'), value: 'checkout' },
            { label: t('actions.breakStart'), value: 'break_start' },
            { label: t('actions.breakEnd'), value: 'break_end' },
            { label: t('actions.batchCorrection'), value: 'batch_correction' },
            { label: t('actions.approvalSubmitted'), value: 'approval_submitted' },
            { label: t('actions.monthlyClosing'), value: 'monthly_closing' },
          ]}
        />
        <Select
          value={statusFilter}
          onChange={(val) => {
            setStatusFilter(val);
            handleFilterChange();
          }}
          style={{ width: 140 }}
          placeholder={t('table.status')}
          allowClear
          onClear={() => {
            setStatusFilter('');
            handleFilterChange();
          }}
          options={[
            { label: t('logs.all'), value: '' },
            { label: t('status.success'), value: 'success' },
            { label: t('status.failure'), value: 'failure' },
            { label: t('status.skipped'), value: 'skipped' },
          ]}
        />
        <Input
          placeholder={t('logs.search')}
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onPressEnter={() => {
            handleFilterChange();
            fetchLogs();
          }}
          allowClear
          style={{ width: 200 }}
        />
      </Space>

      {/* Table */}
      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
        locale={{ emptyText: t('logs.noLogs') }}
      />

      {/* Pagination */}
      {total > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 16,
          }}
        >
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            showSizeChanger
            pageSizeOptions={['10', '20', '50']}
            showTotal={(t) => `${t} items`}
            onChange={(p, ps) => {
              setPage(p);
              setPageSize(ps);
            }}
          />
        </div>
      )}

      {/* Detail modal */}
      <Modal
        title={t('logs.title')}
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        width={720}
      >
        {detailLog && (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text>
              <Text strong>{t('table.time')}:</Text> {detailLog.executed_at}
            </Text>
            <Text>
              <Text strong>{t('table.action')}:</Text>{' '}
              {(() => {
                const keyMap: Record<string, string> = {
                  checkin: 'checkin', checkout: 'checkout',
                  break_start: 'breakStart', break_end: 'breakEnd',
                  batch_correction: 'batchCorrection',
                  approval_submitted: 'approvalSubmitted',
                  monthly_closing: 'monthlyClosing',
                };
                return t(`actions.${keyMap[detailLog.action_type] || detailLog.action_type?.replace('_', '')}`);
              })()}
            </Text>
            <Text>
              <Text strong>{t('table.status')}:</Text>{' '}
              <Tag
                color={
                  STATUS_TAG_CONFIG[detailLog.status]?.color || 'default'
                }
              >
                {t(`status.${detailLog.status}`)}
              </Tag>
            </Text>
            <Text>
              <Text strong>{t('table.trigger')}:</Text>{' '}
              {t(`status.${detailLog.trigger_type || detailLog.trigger}`)}
            </Text>
            {detailLog.company_name && (
              <Text>
                <Text strong>{t('table.company')}:</Text> {detailLog.company_name}
              </Text>
            )}
            {(detailLog.error_message || detailLog.error) && (
              <Text type="danger">
                <Text strong>{t('table.error')}:</Text> {detailLog.error_message || detailLog.error}
              </Text>
            )}
            {detailLog.duration_ms && (
              <Text>
                <Text strong>{t('table.duration')}:</Text>{' '}
                {detailLog.duration_ms}ms
              </Text>
            )}

            {/* Screenshots */}
            {(detailLog.screenshot_before || detailLog.screenshot_after) && (
              <div style={{ marginTop: 16 }}>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>
                  {t('logs.screenshotTitle')}
                </Text>
                <Space size="middle" wrap>
                  {detailLog.screenshot_before && (
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t('logs.before')}
                      </Text>
                      <img
                        src={detailLog.screenshot_before}
                        alt="before"
                        style={{
                          maxWidth: 320,
                          borderRadius: 8,
                          display: 'block',
                          marginTop: 4,
                        }}
                      />
                    </div>
                  )}
                  {detailLog.screenshot_after && (
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t('logs.after')}
                      </Text>
                      <img
                        src={detailLog.screenshot_after}
                        alt="after"
                        style={{
                          maxWidth: 320,
                          borderRadius: 8,
                          display: 'block',
                          marginTop: 4,
                        }}
                      />
                    </div>
                  )}
                </Space>
              </div>
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
};

export default LogsPage;
