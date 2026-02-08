import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Table,
  Select,
  Button,
  DatePicker,
  Input,
  Modal,
  Typography,
  Tag,
  Space,
  Empty,
  Tabs,
  Alert,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  GlobalOutlined,
  CalendarOutlined,
  ScheduleOutlined,
  CheckSquareOutlined,
  CloseOutlined,
  FileAddOutlined,
  FormOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import api from '../api';
import { notifySuccess, notifyError } from '../utils/notify';
import CalendarView from '../components/logs/CalendarView';
import MonthlySummary from '../components/logs/MonthlySummary';
import BatchPunchModal from '../components/logs/BatchPunchModal';
import LeaveRequestModal from '../components/logs/LeaveRequestModal';
import WorkRequestModal from '../components/logs/WorkRequestModal';
import ApprovalSection from '../components/logs/ApprovalSection';
import { useAppSelector, useAppDispatch } from '../store/hooks';
import { fetchConfig } from '../store/configSlice';
import { selectAllMissingDates, clearDateSelection, fetchCapabilities } from '../store/attendanceSlice';

const { Title, Text } = Typography;

// Map country code to flag + label
const COUNTRY_FLAG_MAP: Record<string, string> = {
  jp: '\u{1F1EF}\u{1F1F5}',
  cn: '\u{1F1E8}\u{1F1F3}',
};

const CalendarPage: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { holidaySkipCountries, autoEnabled, oauthConfigured } = useAppSelector((state) => state.config);
  const { selectedDates } = useAppSelector((state) => state.attendance);

  // Country options — use i18n labels
  const COUNTRY_OPTIONS = [
    { label: `\u{1F1EF}\u{1F1F5} ${t('holidays.countryJp')}`, value: 'jp' },
    { label: `\u{1F1E8}\u{1F1F3} ${t('holidays.countryCn')}`, value: 'cn' },
  ];

  // Country and year selectors
  const [country, setCountry] = useState<string>('jp');
  const [year, setYear] = useState(dayjs().year());

  // Holiday data
  const [nationalHolidays, setNationalHolidays] = useState<any[]>([]);
  const [customHolidays, setCustomHolidays] = useState<any[]>([]);
  const [loadingHolidays, setLoadingHolidays] = useState(false);

  // Add modal state
  const [addOpen, setAddOpen] = useState(false);
  const [newDate, setNewDate] = useState<Dayjs | null>(null);
  const [newDesc, setNewDesc] = useState('');

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  // Batch punch state
  const [selectionMode, setSelectionMode] = useState(false);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [workModalOpen, setWorkModalOpen] = useState(false);
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0);

  const years = Array.from({ length: 5 }, (_, i) => dayjs().year() - 2 + i);

  // Holiday skip countries — bidirectional sync with Settings
  const currentSkipValues = (holidaySkipCountries || 'jp').split(',').map(c => c.trim()).filter(Boolean);

  const handleHolidaySkipChange = async (values: string[]) => {
    const countries = values.join(',') || 'jp';
    try {
      await api.setHolidaySkipCountries(countries);
      dispatch(fetchConfig());
      notifySuccess(t('scheduleCard.saved'));
    } catch {
      notifyError(t('scheduleCard.saveFailed'));
    }
  };

  const loadHolidays = useCallback(async () => {
    setLoadingHolidays(true);
    try {
      const res = await api.getHolidays({ year, country });
      setNationalHolidays(res.data.national || []);
      setCustomHolidays(res.data.custom || []);
    } catch (err) {
      console.error('[CalendarPage] Failed to load holidays:', err);
      notifyError(t('holidays.loadFailed'));
    } finally {
      setLoadingHolidays(false);
    }
  }, [year, country, t]);

  useEffect(() => {
    loadHolidays();
  }, [loadHolidays]);

  // Fetch capabilities when OAuth is configured
  useEffect(() => {
    if (oauthConfigured) {
      dispatch(fetchCapabilities());
    }
  }, [oauthConfigured, dispatch]);

  const handleAdd = async () => {
    if (!newDate || !newDesc.trim()) return;
    try {
      await api.addCustomHoliday({
        date: newDate.format('YYYY-MM-DD'),
        description: newDesc.trim(),
      });
      notifySuccess(t('holidays.added'));
      setAddOpen(false);
      setNewDate(null);
      setNewDesc('');
      loadHolidays();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteCustomHoliday(deleteTarget.id);
      notifySuccess(t('holidays.deleted'));
      setDeleteTarget(null);
      loadHolidays();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
    }
  };

  const handleToggleSelectionMode = () => {
    if (selectionMode) {
      // Exit selection mode
      setSelectionMode(false);
      dispatch(clearDateSelection());
    } else {
      setSelectionMode(true);
    }
  };

  const handleSelectAllMissing = () => {
    dispatch(selectAllMissingDates());
  };

  const handleOpenBatchModal = () => {
    if (selectedDates.length > 0) {
      setBatchModalOpen(true);
    }
  };

  const handleBatchModalClose = () => {
    setBatchModalOpen(false);
    setSelectionMode(false);
    dispatch(clearDateSelection());
    // Trigger calendar data refresh after batch submission
    setCalendarRefreshKey(k => k + 1);
  };

  // National holidays table columns
  const nationalColumns: ColumnsType<any> = [
    {
      title: t('table.date'),
      dataIndex: 'date',
      key: 'date',
      width: 150,
    },
    {
      title: t('table.name'),
      dataIndex: 'name',
      key: 'name',
    },
  ];

  // Custom holidays table columns
  const customColumns: ColumnsType<any> = [
    {
      title: t('table.date'),
      dataIndex: 'date',
      key: 'date',
      width: 150,
    },
    {
      title: t('table.description'),
      dataIndex: 'description',
      key: 'description',
    },
    {
      title: t('table.actions'),
      key: 'actions',
      width: 80,
      render: (_: any, record: any) => (
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={() => setDeleteTarget(record)}
        />
      ),
    },
  ];

  // Tab items
  const tabItems = [
    {
      key: 'calendar',
      label: (
        <span>
          <CalendarOutlined /> {t('calendar.title')}
        </span>
      ),
      children: (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Holiday skip config — editable, syncs with Settings */}
          {autoEnabled && (
            <Alert
              type="info"
              showIcon
              message={
                <Space align="center" wrap>
                  <Text style={{ fontSize: 13 }}>{t('settings.holidaySkipTitle')}:</Text>
                  <Select
                    mode="multiple"
                    value={currentSkipValues}
                    onChange={handleHolidaySkipChange}
                    options={COUNTRY_OPTIONS}
                    style={{ minWidth: 200 }}
                    size="small"
                    placeholder={t('settings.holidaySkipPlaceholder')}
                  />
                </Space>
              }
            />
          )}

          {/* Toolbar: batch punch + monthly closing */}
          {oauthConfigured && (
            <Space wrap size="middle">
              <Button
                type={selectionMode ? 'primary' : 'default'}
                icon={selectionMode ? <CloseOutlined /> : <CheckSquareOutlined />}
                onClick={handleToggleSelectionMode}
                size="small"
              >
                {selectionMode ? t('calendar.batchCancel') : t('calendar.batchPunchMode')}
              </Button>
              {selectionMode && (
                <>
                  <Button size="small" onClick={handleSelectAllMissing}>
                    {t('calendar.selectAllMissing')}
                  </Button>
                  <Text type="secondary">
                    {t('calendar.selectedCount', { count: selectedDates.length })}
                  </Text>
                  <Button
                    type="primary"
                    size="small"
                    disabled={selectedDates.length === 0}
                    onClick={handleOpenBatchModal}
                  >
                    {t('calendar.batchSubmit')}
                  </Button>
                </>
              )}
              {!selectionMode && (
                <>
                  <Button
                    icon={<FileAddOutlined />}
                    size="small"
                    onClick={() => setLeaveModalOpen(true)}
                  >
                    {t('calendar.leaveRequest')}
                  </Button>
                  <Button
                    icon={<FormOutlined />}
                    size="small"
                    onClick={() => setWorkModalOpen(true)}
                  >
                    {t('calendar.workRequest')}
                  </Button>
                  <ApprovalSection />
                </>
              )}
            </Space>
          )}

          <MonthlySummary />
          <Card>
            <CalendarView selectionMode={selectionMode} refreshKey={calendarRefreshKey} />
          </Card>
        </Space>
      ),
    },
    {
      key: 'holidays',
      label: (
        <span>
          <ScheduleOutlined /> {t('holidays.title')}
        </span>
      ),
      children: (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Holiday skip config — editable, syncs with Settings */}
          {autoEnabled && (
            <Alert
              type="info"
              showIcon
              message={
                <Space align="center" wrap>
                  <Text style={{ fontSize: 13 }}>{t('settings.holidaySkipTitle')}:</Text>
                  <Select
                    mode="multiple"
                    value={currentSkipValues}
                    onChange={handleHolidaySkipChange}
                    options={COUNTRY_OPTIONS}
                    style={{ minWidth: 200 }}
                    size="small"
                    placeholder={t('settings.holidaySkipPlaceholder')}
                  />
                </Space>
              }
            />
          )}
          {/* Country and year selectors */}
          <Space size="middle" wrap>
            <Space>
              <GlobalOutlined />
              <Select
                value={country}
                onChange={(val) => setCountry(val)}
                options={COUNTRY_OPTIONS}
                style={{ width: 160 }}
              />
            </Space>
            <Select
              value={year}
              onChange={(val) => setYear(val)}
              style={{ width: 100 }}
              options={years.map((y) => ({ label: String(y), value: y }))}
            />
          </Space>

          {/* National holidays section */}
          <Card size="small">
            <Title level={5} style={{ marginTop: 0 }}>
              {t('holidays.nationalTitle')}
            </Title>
            {nationalHolidays.length > 0 ? (
              <Table
                columns={nationalColumns}
                dataSource={nationalHolidays}
                rowKey={(record, index) => `${record.date}-${index}`}
                pagination={false}
                size="small"
                loading={loadingHolidays}
              />
            ) : (
              <Empty description={t('holidays.noNational')} />
            )}
          </Card>

          {/* Custom holidays section */}
          <Card size="small">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 16,
              }}
            >
              <Title level={5} style={{ margin: 0 }}>
                {t('holidays.customTitle')}
              </Title>
              <Button
                type="primary"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => setAddOpen(true)}
              >
                {t('holidays.add')}
              </Button>
            </div>
            {customHolidays.length > 0 ? (
              <Table
                columns={customColumns}
                dataSource={customHolidays}
                rowKey="id"
                pagination={false}
                size="small"
              />
            ) : (
              <Empty description={t('holidays.noCustom')} />
            )}
          </Card>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Tabs defaultActiveKey="calendar" items={tabItems} />

      {/* Batch Punch Modal */}
      <BatchPunchModal open={batchModalOpen} onClose={handleBatchModalClose} />

      {/* Leave Request Modal */}
      <LeaveRequestModal open={leaveModalOpen} onClose={() => setLeaveModalOpen(false)} />
      <WorkRequestModal open={workModalOpen} onClose={() => setWorkModalOpen(false)} />

      {/* Add custom holiday modal */}
      <Modal
        title={t('holidays.addTitle')}
        open={addOpen}
        onCancel={() => {
          setAddOpen(false);
          setNewDate(null);
          setNewDesc('');
        }}
        onOk={handleAdd}
        okText={t('holidays.addBtn')}
        cancelText={t('holidays.cancelBtn')}
        okButtonProps={{ disabled: !newDate || !newDesc.trim() }}
        width={400}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('holidays.datePlaceholder')}
            </Text>
            <DatePicker
              value={newDate}
              onChange={(date) => setNewDate(date)}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('table.description')}
            </Text>
            <Input
              placeholder={t('holidays.descriptionPlaceholder')}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>
        </Space>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        title={t('common.confirm')}
        open={!!deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onOk={handleDelete}
        okText={t('common.delete')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
      >
        <Text>
          {t('holidays.confirmDelete', { date: deleteTarget?.date || '' })}
        </Text>
      </Modal>
    </div>
  );
};

export default CalendarPage;
