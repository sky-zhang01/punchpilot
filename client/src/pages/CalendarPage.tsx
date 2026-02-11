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

  // Selection mode state (mutually exclusive)
  const [selectionMode, setSelectionMode] = useState(false);           // Punch correction mode
  const [leaveSelectionMode, setLeaveSelectionMode] = useState(false); // Leave request mode
  const [workSelectionMode, setWorkSelectionMode] = useState(false);   // Work request mode
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [workModalOpen, setWorkModalOpen] = useState(false);
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0);
  const anyModeActive = selectionMode || leaveSelectionMode || workSelectionMode;

  // Dynamic years from API
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const years = availableYears.length > 0
    ? availableYears
    : Array.from({ length: 5 }, (_, i) => dayjs().year() - 2 + i);

  // Fetch available years when country changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getHolidayAvailableYears(country);
        if (!cancelled && res.data.years?.length > 0) {
          setAvailableYears(res.data.years);
          // If current year is not in the list, select the latest available
          if (!res.data.years.includes(year)) {
            setYear(res.data.years[res.data.years.length - 1]);
          }
        }
      } catch {
        // Fallback: keep hardcoded range
      }
    })();
    return () => { cancelled = true; };
  }, [country]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setSelectionMode(false);
      dispatch(clearDateSelection());
    } else {
      setLeaveSelectionMode(false);
      setWorkSelectionMode(false);
      dispatch(clearDateSelection());
      setSelectionMode(true);
    }
  };

  const handleToggleLeaveSelectionMode = () => {
    if (leaveSelectionMode) {
      setLeaveSelectionMode(false);
      dispatch(clearDateSelection());
    } else {
      setSelectionMode(false);
      setWorkSelectionMode(false);
      dispatch(clearDateSelection());
      setLeaveSelectionMode(true);
    }
  };

  const handleToggleWorkSelectionMode = () => {
    if (workSelectionMode) {
      setWorkSelectionMode(false);
      dispatch(clearDateSelection());
    } else {
      setSelectionMode(false);
      setLeaveSelectionMode(false);
      dispatch(clearDateSelection());
      setWorkSelectionMode(true);
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

  const handleOpenLeaveModal = () => {
    if (selectedDates.length > 0) {
      setLeaveModalOpen(true);
    }
  };

  const handleBatchModalClose = () => {
    setBatchModalOpen(false);
    setSelectionMode(false);
    dispatch(clearDateSelection());
    // Trigger calendar data refresh after batch submission
    setCalendarRefreshKey(k => k + 1);
  };

  const handleLeaveModalClose = () => {
    setLeaveModalOpen(false);
    setLeaveSelectionMode(false);
    dispatch(clearDateSelection());
    setCalendarRefreshKey(k => k + 1);
  };

  const handleOpenWorkModal = () => {
    if (selectedDates.length > 0) {
      setWorkModalOpen(true);
    }
  };

  const handleWorkModalClose = () => {
    setWorkModalOpen(false);
    setWorkSelectionMode(false);
    dispatch(clearDateSelection());
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

          {/* Toolbar: punch correction + leave request + work request */}
          {oauthConfigured && (
            <Space wrap size="middle">
              {/* Punch Correction Mode button */}
              <Button
                type={selectionMode ? 'primary' : 'default'}
                icon={selectionMode ? <CloseOutlined /> : <CheckSquareOutlined />}
                onClick={handleToggleSelectionMode}
                size="small"
                disabled={anyModeActive && !selectionMode}
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
              {/* Leave Request Mode button */}
              <Button
                type={leaveSelectionMode ? 'primary' : 'default'}
                icon={leaveSelectionMode ? <CloseOutlined /> : <FileAddOutlined />}
                onClick={handleToggleLeaveSelectionMode}
                size="small"
                disabled={anyModeActive && !leaveSelectionMode}
              >
                {leaveSelectionMode ? t('calendar.batchCancel') : t('calendar.leaveRequest')}
              </Button>
              {leaveSelectionMode && (
                <>
                  <Text type="secondary">
                    {t('calendar.selectedCount', { count: selectedDates.length })}
                  </Text>
                  <Button
                    type="primary"
                    size="small"
                    disabled={selectedDates.length === 0}
                    onClick={handleOpenLeaveModal}
                  >
                    {t('calendar.batchSubmit')}
                  </Button>
                </>
              )}
              {/* Work Request Mode button */}
              <Button
                type={workSelectionMode ? 'primary' : 'default'}
                icon={workSelectionMode ? <CloseOutlined /> : <FormOutlined />}
                onClick={handleToggleWorkSelectionMode}
                size="small"
                disabled={anyModeActive && !workSelectionMode}
              >
                {workSelectionMode ? t('calendar.batchCancel') : t('calendar.workRequest')}
              </Button>
              {workSelectionMode && (
                <>
                  <Text type="secondary">
                    {t('calendar.selectedCount', { count: selectedDates.length })}
                  </Text>
                  <Button
                    type="primary"
                    size="small"
                    disabled={selectedDates.length === 0}
                    onClick={handleOpenWorkModal}
                  >
                    {t('calendar.batchSubmit')}
                  </Button>
                </>
              )}
              {/* Approval section only when no mode active */}
              {!anyModeActive && <ApprovalSection />}
            </Space>
          )}

          <MonthlySummary />
          <Card>
            <CalendarView selectionMode={selectionMode} leaveSelectionMode={leaveSelectionMode || workSelectionMode} refreshKey={calendarRefreshKey} />
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
      <LeaveRequestModal open={leaveModalOpen} onClose={handleLeaveModalClose} preSelectedDates={selectedDates} />
      <WorkRequestModal open={workModalOpen} onClose={handleWorkModalClose} preSelectedDates={selectedDates} />

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
