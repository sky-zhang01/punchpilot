import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Modal,
  Radio,
  TimePicker,
  Switch,
  Space,
  Typography,
  Divider,
  Alert,
  Tag,
  Input,
  Button,
} from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { batchSubmit, clearBatchResults } from '../../store/attendanceSlice';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Text } = Typography;
const { TextArea } = Input;

const TIME_FORMAT = 'HH:mm';

interface BatchPunchModalProps {
  open: boolean;
  onClose: () => void;
}

// Generate a random time between start and end (Dayjs objects, same day)
function randomTimeBetween(start: Dayjs, end: Dayjs): Dayjs {
  const startMins = start.hour() * 60 + start.minute();
  const endMins = end.hour() * 60 + end.minute();
  const diff = endMins - startMins;
  if (diff <= 0) return start;
  const randMins = Math.floor(Math.random() * (diff + 1));
  return start.startOf('day').add(startMins + randMins, 'minute');
}

// Build ISO 8601 time string in JST for a given date + time
function buildISOTime(dateStr: string, time: Dayjs): string {
  const h = String(time.hour()).padStart(2, '0');
  const m = String(time.minute()).padStart(2, '0');
  return `${dateStr}T${h}:${m}:00+09:00`;
}

/**
 * BatchPunchModal — User's one-click batch punch.
 *
 * User flow: select dates on calendar → open this modal → set times → submit.
 * That's it. The server decides whether each date goes via PUT (direct) or
 * POST (approval) based on is_editable and company capabilities.
 * The user doesn't need to know or care about the underlying mechanism.
 */
const BatchPunchModal: React.FC<BatchPunchModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { selectedDates, batchPunchLoading, records, capabilities, batchPunchResults } = useAppSelector(
    (state) => state.attendance
  );
  const { schedules } = useAppSelector((state) => state.config);

  // Show reason field only if company has approval workflow (some dates may need it)
  const hasApproval = capabilities?.approval ?? false;

  // Get defaults from existing schedule config
  const checkinSchedule = schedules.find((s) => s.action_type === 'checkin');
  const checkoutSchedule = schedules.find((s) => s.action_type === 'checkout');
  const breakStartSchedule = schedules.find((s) => s.action_type === 'break_start');
  const breakEndSchedule = schedules.find((s) => s.action_type === 'break_end');

  const [timeMode, setTimeMode] = useState<'fixed' | 'random'>('fixed');
  const [includeBreak, setIncludeBreak] = useState(true);
  const [reason, setReason] = useState('');
  const [showResults, setShowResults] = useState(false);

  // Fixed times
  const [fixedCheckin, setFixedCheckin] = useState<Dayjs>(
    dayjs(checkinSchedule?.fixed_time || '10:00', TIME_FORMAT)
  );
  const [fixedCheckout, setFixedCheckout] = useState<Dayjs>(
    dayjs(checkoutSchedule?.fixed_time || '19:00', TIME_FORMAT)
  );
  const [fixedBreakStart, setFixedBreakStart] = useState<Dayjs>(
    dayjs(breakStartSchedule?.fixed_time || '12:00', TIME_FORMAT)
  );
  const [fixedBreakEnd, setFixedBreakEnd] = useState<Dayjs>(
    dayjs(breakEndSchedule?.fixed_time || '13:00', TIME_FORMAT)
  );

  // Random window times
  const [checkinWinStart, setCheckinWinStart] = useState<Dayjs>(
    dayjs(checkinSchedule?.window_start || '09:50', TIME_FORMAT)
  );
  const [checkinWinEnd, setCheckinWinEnd] = useState<Dayjs>(
    dayjs(checkinSchedule?.window_end || '10:10', TIME_FORMAT)
  );
  const [checkoutWinStart, setCheckoutWinStart] = useState<Dayjs>(
    dayjs(checkoutSchedule?.window_start || '19:00', TIME_FORMAT)
  );
  const [checkoutWinEnd, setCheckoutWinEnd] = useState<Dayjs>(
    dayjs(checkoutSchedule?.window_end || '19:30', TIME_FORMAT)
  );
  const [breakStartWinStart, setBreakStartWinStart] = useState<Dayjs>(
    dayjs(breakStartSchedule?.window_start || '12:00', TIME_FORMAT)
  );
  const [breakStartWinEnd, setBreakStartWinEnd] = useState<Dayjs>(
    dayjs(breakStartSchedule?.window_end || '12:15', TIME_FORMAT)
  );
  const [breakEndWinStart, setBreakEndWinStart] = useState<Dayjs>(
    dayjs(breakEndSchedule?.window_start || '13:00', TIME_FORMAT)
  );
  const [breakEndWinEnd, setBreakEndWinEnd] = useState<Dayjs>(
    dayjs(breakEndSchedule?.window_end || '13:15', TIME_FORMAT)
  );

  // Reset state when modal opens
  React.useEffect(() => {
    if (open) {
      setReason('');
      setShowResults(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    const sortedDates = [...selectedDates].sort();
    const entries = sortedDates.map((date) => {
      let checkinTime: Dayjs;
      let checkoutTime: Dayjs;
      let breakStart: Dayjs | null = null;
      let breakEnd: Dayjs | null = null;

      if (timeMode === 'fixed') {
        checkinTime = fixedCheckin;
        checkoutTime = fixedCheckout;
        if (includeBreak) {
          breakStart = fixedBreakStart;
          breakEnd = fixedBreakEnd;
        }
      } else {
        checkinTime = randomTimeBetween(checkinWinStart, checkinWinEnd);
        checkoutTime = randomTimeBetween(checkoutWinStart, checkoutWinEnd);
        if (includeBreak) {
          breakStart = randomTimeBetween(breakStartWinStart, breakStartWinEnd);
          breakEnd = randomTimeBetween(breakEndWinStart, breakEndWinEnd);
        }
      }

      const entry: any = {
        date,
        clock_in_at: buildISOTime(date, checkinTime),
        clock_out_at: buildISOTime(date, checkoutTime),
        // Pass is_editable so the server knows which strategy to use
        is_editable: records[date]?.is_editable ?? true,
      };

      if (includeBreak && breakStart && breakEnd) {
        entry.break_records = [
          {
            clock_in_at: buildISOTime(date, breakStart),
            clock_out_at: buildISOTime(date, breakEnd),
          },
        ];
      }

      return entry;
    });

    try {
      const result = await dispatch(batchSubmit({
        entries,
        reason: reason.trim() || undefined,
      })).unwrap();

      const successCount = result.results.filter((r: any) => r.success).length;
      const failedCount = result.results.filter((r: any) => !r.success).length;

      if (failedCount === 0) {
        notifySuccess(t('calendar.batchSuccess', { success: successCount, total: result.results.length }));
        onClose();
      } else {
        // Show results view with details
        setShowResults(true);
        if (successCount > 0) {
          notifySuccess(t('calendar.batchSuccess', { success: successCount, total: result.results.length }));
        }
      }
    } catch (err: any) {
      notifyError(err?.message || t('calendar.approvalFailed'));
    }
  };

  const handleClose = () => {
    dispatch(clearBatchResults());
    setShowResults(false);
    onClose();
  };

  // When showing results after a batch submission with failures
  if (showResults && batchPunchResults.length > 0) {
    const failedResults = batchPunchResults.filter(r => !r.success);
    const successResults = batchPunchResults.filter(r => r.success);
    const webResults = batchPunchResults.filter(r => r.method === 'web_correction');
    const needsWebCreds = failedResults.some(r => r.error === 'web_credentials_required');
    const webCredsInvalid = failedResults.some(r => r.error === 'web_credentials_invalid');

    return (
      <Modal
        title={t('calendar.batchPunchTitle')}
        open={open}
        onCancel={handleClose}
        footer={
          <Button onClick={handleClose}>{t('common.confirm')}</Button>
        }
        width={520}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {successResults.length > 0 && (
            <Alert
              type="success"
              showIcon
              message={t('calendar.batchSuccess', { success: successResults.length, total: batchPunchResults.length })}
            />
          )}

          {/* Show web correction successes separately */}
          {webResults.filter(r => r.success).length > 0 && (
            <Alert
              type="info"
              showIcon
              message={t('calendar.batchWebSuccess', {
                count: webResults.filter(r => r.success).length,
              })}
            />
          )}

          {failedResults.length > 0 && (
            <>
              <Alert
                type="error"
                showIcon
                message={t('calendar.batchFailed', { failed: failedResults.length, total: batchPunchResults.length })}
              />

              {/* Case 1: Web credentials not configured at all */}
              {needsWebCreds && (
                <Alert
                  type="warning"
                  showIcon
                  message={t('calendar.batchWebCredsRequired')}
                  description={
                    <Space direction="vertical" size="small" style={{ marginTop: 8 }}>
                      <Text style={{ fontSize: 12 }}>{t('calendar.batchWebCredsDesc')}</Text>
                      <Button
                        icon={<SettingOutlined />}
                        size="small"
                        onClick={() => { onClose(); navigate('/settings'); }}
                      >
                        {t('nav.settings')}
                      </Button>
                    </Space>
                  }
                />
              )}

              {/* Case 2: Web credentials exist but login failed (expired/incorrect) */}
              {webCredsInvalid && (
                <Alert
                  type="warning"
                  showIcon
                  message={t('calendar.batchWebCredsInvalid')}
                  description={
                    <Space direction="vertical" size="small" style={{ marginTop: 8 }}>
                      <Text style={{ fontSize: 12 }}>{t('calendar.batchWebCredsInvalidDesc')}</Text>
                      <Button
                        type="primary"
                        icon={<SettingOutlined />}
                        size="small"
                        onClick={() => { onClose(); navigate('/settings'); }}
                      >
                        {t('calendar.batchWebCredsUpdate')}
                      </Button>
                    </Space>
                  }
                />
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {failedResults.map((r) => (
                  <Tag key={r.date} color="red">{r.date}</Tag>
                ))}
              </div>
            </>
          )}
        </Space>
      </Modal>
    );
  }

  return (
    <Modal
      title={t('calendar.batchPunchTitle')}
      open={open}
      onCancel={handleClose}
      onOk={handleSubmit}
      okText={t('calendar.batchSubmit')}
      cancelText={t('calendar.batchCancel')}
      confirmLoading={batchPunchLoading}
      okButtonProps={{ disabled: selectedDates.length === 0 || batchPunchLoading }}
      width={520}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Selected dates */}
        <Alert
          type="info"
          showIcon
          message={t('calendar.batchConfirm', { count: selectedDates.length })}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {[...selectedDates].sort().map((date) => (
            <Tag key={date} color="blue">{date}</Tag>
          ))}
        </div>

        <Divider style={{ margin: '4px 0' }} />

        {/* Time mode */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            {t('calendar.batchTimeMode')}
          </Text>
          <Radio.Group value={timeMode} onChange={(e) => setTimeMode(e.target.value)}>
            <Radio.Button value="fixed">{t('calendar.batchFixed')}</Radio.Button>
            <Radio.Button value="random">{t('calendar.batchRandom')}</Radio.Button>
          </Radio.Group>
        </div>

        <Divider style={{ margin: '4px 0' }} />

        {/* Time settings */}
        {timeMode === 'fixed' ? (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Space>
              <Text style={{ width: 80, display: 'inline-block' }}>{t('calendar.batchCheckin')}:</Text>
              <TimePicker value={fixedCheckin} onChange={(v) => v && setFixedCheckin(v)} format={TIME_FORMAT} minuteStep={5} />
            </Space>
            <Space>
              <Text style={{ width: 80, display: 'inline-block' }}>{t('calendar.batchCheckout')}:</Text>
              <TimePicker value={fixedCheckout} onChange={(v) => v && setFixedCheckout(v)} format={TIME_FORMAT} minuteStep={5} />
            </Space>
          </Space>
        ) : (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('calendar.batchCheckin')}</Text>
            <Space>
              <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowStart')}:</Text>
              <TimePicker size="small" value={checkinWinStart} onChange={(v) => v && setCheckinWinStart(v)} format={TIME_FORMAT} minuteStep={5} />
              <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowEnd')}:</Text>
              <TimePicker size="small" value={checkinWinEnd} onChange={(v) => v && setCheckinWinEnd(v)} format={TIME_FORMAT} minuteStep={5} />
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('calendar.batchCheckout')}</Text>
            <Space>
              <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowStart')}:</Text>
              <TimePicker size="small" value={checkoutWinStart} onChange={(v) => v && setCheckoutWinStart(v)} format={TIME_FORMAT} minuteStep={5} />
              <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowEnd')}:</Text>
              <TimePicker size="small" value={checkoutWinEnd} onChange={(v) => v && setCheckoutWinEnd(v)} format={TIME_FORMAT} minuteStep={5} />
            </Space>
          </Space>
        )}

        <Divider style={{ margin: '4px 0' }} />

        {/* Break toggle */}
        <Space>
          <Switch checked={includeBreak} onChange={setIncludeBreak} />
          <Text>{t('calendar.batchBreak')}</Text>
        </Space>

        {/* Break time settings */}
        {includeBreak && (
          timeMode === 'fixed' ? (
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Space>
                <Text style={{ width: 80, display: 'inline-block' }}>{t('calendar.batchBreakStart')}:</Text>
                <TimePicker value={fixedBreakStart} onChange={(v) => v && setFixedBreakStart(v)} format={TIME_FORMAT} minuteStep={5} />
              </Space>
              <Space>
                <Text style={{ width: 80, display: 'inline-block' }}>{t('calendar.batchBreakEnd')}:</Text>
                <TimePicker value={fixedBreakEnd} onChange={(v) => v && setFixedBreakEnd(v)} format={TIME_FORMAT} minuteStep={5} />
              </Space>
            </Space>
          ) : (
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('calendar.batchBreakStart')}</Text>
              <Space>
                <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowStart')}:</Text>
                <TimePicker size="small" value={breakStartWinStart} onChange={(v) => v && setBreakStartWinStart(v)} format={TIME_FORMAT} minuteStep={5} />
                <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowEnd')}:</Text>
                <TimePicker size="small" value={breakStartWinEnd} onChange={(v) => v && setBreakStartWinEnd(v)} format={TIME_FORMAT} minuteStep={5} />
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('calendar.batchBreakEnd')}</Text>
              <Space>
                <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowStart')}:</Text>
                <TimePicker size="small" value={breakEndWinStart} onChange={(v) => v && setBreakEndWinStart(v)} format={TIME_FORMAT} minuteStep={5} />
                <Text style={{ fontSize: 12 }}>{t('calendar.batchWindowEnd')}:</Text>
                <TimePicker size="small" value={breakEndWinEnd} onChange={(v) => v && setBreakEndWinEnd(v)} format={TIME_FORMAT} minuteStep={5} />
              </Space>
            </Space>
          )
        )}

        {/* Reason — only shown if the company has approval workflow */}
        {hasApproval && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <div>
              <Text style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                {t('calendar.correctionReason')}
              </Text>
              <TextArea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('calendar.correctionReasonPlaceholder')}
                rows={2}
              />
            </div>
          </>
        )}
      </Space>
    </Modal>
  );
};

export default BatchPunchModal;
