import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  TimePicker,
  Radio,
  Button,
  Switch,
  Select,
  Typography,
  Alert,
  Tag,
  Space,
  Row,
  Col,
} from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { updateSchedule, fetchConfig, toggleMaster } from '../../store/configSlice';
import { notifySuccess, notifyError } from '../../utils/notify';
import api from '../../api';

const { Title, Text } = Typography;

const ACTION_LABELS: Record<string, string> = {
  checkin: 'scheduleCard.checkin',
  checkout: 'scheduleCard.checkout',
  break_start: 'scheduleCard.breakStart',
  break_end: 'scheduleCard.breakEnd',
};

const TIME_FORMAT = 'HH:mm';

const ScheduleConfigCard: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { schedules, autoEnabled, holidaySkipCountries } = useAppSelector((state) => state.config);

  // Local state for editing
  const [editState, setEditState] = useState<Record<string, any>>({});

  const getEditValue = (actionType: string, field: string, fallback: any) => {
    return editState[`${actionType}.${field}`] ?? fallback;
  };

  const setEditValue = (actionType: string, field: string, value: any) => {
    setEditState((prev) => ({ ...prev, [`${actionType}.${field}`]: value }));
  };

  // Helper: convert "HH:mm" to total minutes
  const timeToMinutes = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };

  const handleSave = async (actionType: string) => {
    const schedule = schedules.find((s) => s.action_type === actionType);
    if (!schedule) return;

    const mode = getEditValue(actionType, 'mode', schedule.mode);
    const data: Record<string, any> = { mode };

    if (mode === 'fixed') {
      data.fixed_time = getEditValue(actionType, 'fixed_time', schedule.fixed_time);
    } else {
      data.window_start = getEditValue(actionType, 'window_start', schedule.window_start);
      data.window_end = getEditValue(actionType, 'window_end', schedule.window_end);
    }

    // Validate window_start < window_end for random mode
    if (mode === 'random' && data.window_start && data.window_end) {
      if (timeToMinutes(data.window_start) >= timeToMinutes(data.window_end)) {
        notifyError(t('scheduleCard.windowStartBeforeEnd'));
        return;
      }
    }

    // Validate break duration >= 60 minutes (both fixed and random modes)
    // fixed: end.fixed - start.fixed >= 60
    // random: end.window_end - start.window_start >= 60
    //   (ensures at least 60 minutes of selectable break range)
    if (actionType === 'break_start' || actionType === 'break_end') {
      const breakStartSchedule = schedules.find((s) => s.action_type === 'break_start');
      const breakEndSchedule = schedules.find((s) => s.action_type === 'break_end');
      if (breakStartSchedule && breakEndSchedule) {
        const startMode = actionType === 'break_start' ? mode : getEditValue('break_start', 'mode', breakStartSchedule.mode);
        const endMode = actionType === 'break_end' ? mode : getEditValue('break_end', 'mode', breakEndSchedule.mode);

        // "earliest possible start" of break
        let earliestStart: string | undefined;
        if (startMode === 'fixed') {
          earliestStart = actionType === 'break_start'
            ? (data.fixed_time || getEditValue('break_start', 'fixed_time', breakStartSchedule.fixed_time))
            : getEditValue('break_start', 'fixed_time', breakStartSchedule.fixed_time);
        } else {
          // random: earliest start = window_start of break_start
          earliestStart = actionType === 'break_start'
            ? (data.window_start || getEditValue('break_start', 'window_start', breakStartSchedule.window_start))
            : getEditValue('break_start', 'window_start', breakStartSchedule.window_start);
        }

        // "latest possible end" of break
        let latestEnd: string | undefined;
        if (endMode === 'fixed') {
          latestEnd = actionType === 'break_end'
            ? (data.fixed_time || getEditValue('break_end', 'fixed_time', breakEndSchedule.fixed_time))
            : getEditValue('break_end', 'fixed_time', breakEndSchedule.fixed_time);
        } else {
          // random: latest end = window_end of break_end
          latestEnd = actionType === 'break_end'
            ? (data.window_end || getEditValue('break_end', 'window_end', breakEndSchedule.window_end))
            : getEditValue('break_end', 'window_end', breakEndSchedule.window_end);
        }

        if (earliestStart && latestEnd) {
          const duration = timeToMinutes(latestEnd) - timeToMinutes(earliestStart);
          if (duration < 60) {
            notifyError(t('scheduleCard.breakMinDuration'));
            return;
          }
        }
      }
    }

    try {
      await dispatch(updateSchedule({ actionType, data }));
      notifySuccess(t('scheduleCard.saved'));
    } catch {
      notifyError(t('scheduleCard.saveFailed'));
    }
  };

  // Convert "HH:mm" string to dayjs for TimePicker value
  const toDayjs = (timeStr: string | undefined) => {
    if (!timeStr) return undefined;
    return dayjs(timeStr, TIME_FORMAT);
  };

  // Convert dayjs to "HH:mm" string for storage
  const fromDayjs = (d: dayjs.Dayjs | null) => {
    if (!d) return '';
    return d.format(TIME_FORMAT);
  };

  // Holiday skip country options
  const COUNTRY_OPTIONS = [
    { label: `\u{1F1EF}\u{1F1F5} ${t('holidays.countryJp')}`, value: 'jp' },
    { label: `\u{1F1E8}\u{1F1F3} ${t('holidays.countryCn')}`, value: 'cn' },
  ];

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

  const currentSkipValues = (holidaySkipCountries || 'jp').split(',').map(c => c.trim());

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Header with auto-scheduling master toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space align="center">
            <ClockCircleOutlined />
            <Title level={5} style={{ margin: 0 }}>
              {t('settings.scheduleTitle')}
            </Title>
          </Space>
          <Space align="center">
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('settings.autoScheduling')}
            </Text>
            <Switch
              checked={autoEnabled}
              onChange={() => dispatch(toggleMaster())}
            />
          </Space>
        </div>

        {/* Auto-scheduling status */}
        {!autoEnabled && (
          <Alert type="warning" showIcon message={t('settings.autoDisabledHint')} />
        )}

        {/* Holiday skip country selector */}
        <Card size="small">
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text strong>{t('settings.holidaySkipTitle')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('settings.holidaySkipHint')}
            </Text>
            <Select
              mode="multiple"
              value={currentSkipValues}
              onChange={handleHolidaySkipChange}
              options={COUNTRY_OPTIONS}
              style={{ width: '100%' }}
              placeholder={t('settings.holidaySkipPlaceholder')}
            />
          </Space>
        </Card>

        {/* Lunch break constraint note */}
        <Alert
          type="info"
          showIcon
          message={`${t('settings.lunchBreak')}: ${t('settings.lunchBreakNote')}`}
        />

        {/* Schedule cards */}
        {schedules.map((schedule) => {
          const mode = getEditValue(schedule.action_type, 'mode', schedule.mode);

          return (
            <Card
              key={schedule.action_type}
              size="small"
              style={{ border: '1px solid #e2e8f0' }}
            >
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                {/* Action header with resolved time */}
                <Row justify="space-between" align="middle">
                  <Col>
                    <Text strong style={{ fontSize: 15 }}>
                      {t(ACTION_LABELS[schedule.action_type] || schedule.action_type)}
                    </Text>
                  </Col>
                  <Col>
                    {schedule.resolved_time && (
                      <Tag color="blue">
                        {t('scheduleCard.resolvedTime')}: {schedule.resolved_time}
                      </Tag>
                    )}
                  </Col>
                </Row>

                {/* Mode toggle */}
                <Space align="center">
                  <Text type="secondary">{t('scheduleCard.mode')}:</Text>
                  <Radio.Group
                    value={mode}
                    size="small"
                    onChange={(e) =>
                      setEditValue(schedule.action_type, 'mode', e.target.value)
                    }
                  >
                    <Radio.Button value="fixed">{t('scheduleCard.fixed')}</Radio.Button>
                    <Radio.Button value="random">{t('scheduleCard.random')}</Radio.Button>
                  </Radio.Group>
                </Space>

                {/* Time inputs */}
                {mode === 'fixed' ? (
                  <Space align="center">
                    <Text type="secondary">{t('scheduleCard.time')}:</Text>
                    <TimePicker
                      format={TIME_FORMAT}
                      value={toDayjs(
                        getEditValue(
                          schedule.action_type,
                          'fixed_time',
                          schedule.fixed_time
                        )
                      )}
                      onChange={(val) =>
                        setEditValue(
                          schedule.action_type,
                          'fixed_time',
                          fromDayjs(val)
                        )
                      }
                      minuteStep={1}
                      needConfirm={false}
                      style={{ width: 120 }}
                    />
                  </Space>
                ) : (
                  <Space align="center" wrap>
                    <Text type="secondary">{t('scheduleCard.start')}:</Text>
                    <TimePicker
                      format={TIME_FORMAT}
                      value={toDayjs(
                        getEditValue(
                          schedule.action_type,
                          'window_start',
                          schedule.window_start
                        )
                      )}
                      onChange={(val) =>
                        setEditValue(
                          schedule.action_type,
                          'window_start',
                          fromDayjs(val)
                        )
                      }
                      minuteStep={1}
                      needConfirm={false}
                      style={{ width: 120 }}
                    />
                    <Text type="secondary">{t('scheduleCard.end')}:</Text>
                    <TimePicker
                      format={TIME_FORMAT}
                      value={toDayjs(
                        getEditValue(
                          schedule.action_type,
                          'window_end',
                          schedule.window_end
                        )
                      )}
                      onChange={(val) =>
                        setEditValue(
                          schedule.action_type,
                          'window_end',
                          fromDayjs(val)
                        )
                      }
                      minuteStep={1}
                      needConfirm={false}
                      style={{ width: 120 }}
                    />
                  </Space>
                )}

                {/* Save button */}
                <Button
                  type="primary"
                  size="small"
                  onClick={() => handleSave(schedule.action_type)}
                >
                  {t('common.save')}
                </Button>
              </Space>
            </Card>
          );
        })}
      </Space>
    </Card>
  );
};

export default ScheduleConfigCard;
