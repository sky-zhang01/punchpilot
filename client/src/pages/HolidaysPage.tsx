import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Table,
  Select,
  Button,
  DatePicker,
  Input,
  Modal,
  Typography,
  Tag,
  Space,
  Alert,
  Card,
  Empty,
} from 'antd';
import { PlusOutlined, DeleteOutlined, GlobalOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import api from '../api';
import { notifySuccess, notifyError } from '../utils/notify';

const { Title, Text } = Typography;

// Country options for the selector
const COUNTRY_OPTIONS = [
  { label: 'Japan \u{1F1EF}\u{1F1F5}', value: 'jp' },
  { label: 'China \u{1F1E8}\u{1F1F3}', value: 'cn' },
];

const HolidaysPage: React.FC = () => {
  const { t } = useTranslation();

  // Country and year selectors
  const [country, setCountry] = useState<string>('jp');
  const [year, setYear] = useState(dayjs().year());

  // Holiday data
  const [nationalHolidays, setNationalHolidays] = useState<any[]>([]);
  const [customHolidays, setCustomHolidays] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Add modal state
  const [addOpen, setAddOpen] = useState(false);
  const [newDate, setNewDate] = useState<Dayjs | null>(null);
  const [newDesc, setNewDesc] = useState('');

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

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

  const loadHolidays = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { year };
      // For non-Japan countries, pass the country parameter
      if (country !== 'jp') {
        params.country = country;
      }
      const res = await api.getHolidays(params);
      setNationalHolidays(res.data.national || []);
      setCustomHolidays(res.data.custom || []);
    } catch {
      notifyError(t('holidays.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [year, country, t]);

  useEffect(() => {
    loadHolidays();
  }, [loadHolidays]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Top selectors: country and year */}
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
      <Card>
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
            loading={loading}
          />
        ) : (
          <Empty description={t('holidays.noNational')} />
        )}
      </Card>

      {/* Custom holidays section */}
      <Card>
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

export default HolidaysPage;
