import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
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
import { TaskResultSummary } from './TaskRecoveryPanel';
import { resolveBreakTimes } from '../../../../shared/schedule-policy.js';
import { isTimeString } from '../../../../shared/date-time.js';

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

const timeValue = (time: string | null) => isTimeString(time) ? dayjs(`2000-01-01T${time}:00`) : dayjs(NaN);

/**
 * BatchPunchModal — User's one-click batch punch.
 *
 * User flow: select dates on calendar → open this modal → set times → submit.
 * That's it. The server re-reads each date before selecting a safe write path.
 * The user doesn't need to know or care about the underlying mechanism.
 */
const BatchPunchModal: React.FC<BatchPunchModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { selectedDates, batchPunchLoading, records, capabilities, batchPunchResults, batchTask } = useAppSelector(
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
  const [queryPaused, setQueryPaused] = useState(false);
  const [admissionUnknown, setAdmissionUnknown] = useState(false);

  // Fixed times
  const [fixedCheckin, setFixedCheckin] = useState<Dayjs>(
    timeValue(checkinSchedule?.fixed_time || '')
  );
  const [fixedCheckout, setFixedCheckout] = useState<Dayjs>(
    timeValue(checkoutSchedule?.fixed_time || '')
  );
  const [fixedBreakStart, setFixedBreakStart] = useState<Dayjs>(
    timeValue(breakStartSchedule?.fixed_time || '')
  );
  const [fixedBreakEnd, setFixedBreakEnd] = useState<Dayjs>(
    timeValue(breakEndSchedule?.fixed_time || '')
  );

  // Random window times
  const [checkinWinStart, setCheckinWinStart] = useState<Dayjs>(
    timeValue(checkinSchedule?.window_start || '')
  );
  const [checkinWinEnd, setCheckinWinEnd] = useState<Dayjs>(
    timeValue(checkinSchedule?.window_end || '')
  );
  const [checkoutWinStart, setCheckoutWinStart] = useState<Dayjs>(
    timeValue(checkoutSchedule?.window_start || '')
  );
  const [checkoutWinEnd, setCheckoutWinEnd] = useState<Dayjs>(
    timeValue(checkoutSchedule?.window_end || '')
  );
  const [breakStartWinStart, setBreakStartWinStart] = useState<Dayjs>(
    timeValue(breakStartSchedule?.window_start || '')
  );
  const [breakStartWinEnd, setBreakStartWinEnd] = useState<Dayjs>(
    timeValue(breakStartSchedule?.window_end || '')
  );
  const [breakEndWinStart, setBreakEndWinStart] = useState<Dayjs>(
    timeValue(breakEndSchedule?.window_start || '')
  );
  const [breakEndWinEnd, setBreakEndWinEnd] = useState<Dayjs>(
    timeValue(breakEndSchedule?.window_end || '')
  );

  const initialized = React.useRef(false);
  // Read saved values on opening; background refresh must not replace user edits.
  React.useEffect(() => {
    if (!open) { initialized.current = false; return; }
    if (initialized.current || !checkinSchedule || !checkoutSchedule || !breakStartSchedule || !breakEndSchedule) return;
    initialized.current = true;
    setReason(''); setShowResults(false); setQueryPaused(false); setAdmissionUnknown(false);
    setTimeMode(checkinSchedule.mode === 'random' ? 'random' : 'fixed');
    setFixedCheckin(timeValue(checkinSchedule.fixed_time));
    setFixedCheckout(timeValue(checkoutSchedule.fixed_time));
    setFixedBreakStart(timeValue(breakStartSchedule.fixed_time));
    setFixedBreakEnd(timeValue(breakEndSchedule.fixed_time));
    setCheckinWinStart(timeValue(checkinSchedule.window_start));
    setCheckinWinEnd(timeValue(checkinSchedule.window_end));
    setCheckoutWinStart(timeValue(checkoutSchedule.window_start));
    setCheckoutWinEnd(timeValue(checkoutSchedule.window_end));
    setBreakStartWinStart(timeValue(breakStartSchedule.window_start));
    setBreakStartWinEnd(timeValue(breakStartSchedule.window_end));
    setBreakEndWinStart(timeValue(breakEndSchedule.window_start));
    setBreakEndWinEnd(timeValue(breakEndSchedule.window_end));
  }, [open, schedules]);

  const timesReady = (timeMode === 'fixed'
    ? [fixedCheckin, fixedCheckout, ...(includeBreak ? [fixedBreakStart, fixedBreakEnd] : [])]
    : [checkinWinStart, checkinWinEnd, checkoutWinStart, checkoutWinEnd,
      ...(includeBreak ? [breakStartWinStart, breakStartWinEnd, breakEndWinStart, breakEndWinEnd] : [])])
    .every(time => time.isValid());

  const handleSubmit = async () => {
    if (!timesReady) return;
    const breakConfig = (fixed: Dayjs, start: Dayjs, end: Dayjs) => ({
      mode: timeMode, fixed_time: fixed.format(TIME_FORMAT),
      window_start: start.format(TIME_FORMAT), window_end: end.format(TIME_FORMAT),
    });
    const startConfig = breakConfig(fixedBreakStart, breakStartWinStart, breakStartWinEnd);
    const endConfig = breakConfig(fixedBreakEnd, breakEndWinStart, breakEndWinEnd);
    if (timeMode === 'random' && [[checkinWinStart, checkinWinEnd], [checkoutWinStart, checkoutWinEnd],
      ...(includeBreak ? [[breakStartWinStart, breakStartWinEnd], [breakEndWinStart, breakEndWinEnd]] : [])]
      .some(([start, end]) => !start.isValid() || !end.isValid() || !start.isBefore(end))) {
      notifyError(t('scheduleCard.windowStartBeforeEnd'));
      return;
    }
    if (includeBreak && !resolveBreakTimes(startConfig, endConfig, {}, () => 0)) {
      notifyError(t('scheduleCard.breakMinDuration'));
      return;
    }
    const entries = [...selectedDates].sort().map((date) => {
      const checkinTime = timeMode === 'fixed' ? fixedCheckin : randomTimeBetween(checkinWinStart, checkinWinEnd);
      const checkoutTime = timeMode === 'fixed' ? fixedCheckout : randomTimeBetween(checkoutWinStart, checkoutWinEnd);
      const breaks = includeBreak ? resolveBreakTimes(startConfig, endConfig) : null;
      return {
        date,
        clock_in_at: checkinTime.format(TIME_FORMAT),
        clock_out_at: checkoutTime.format(TIME_FORMAT),
        is_editable: records[date]?.is_editable ?? true,
        ...(breaks ? { break_records: [{ clock_in_at: breaks.start, clock_out_at: breaks.end }] } : {}),
      };
    });

    try {
      const result = await dispatch(batchSubmit({
        entries,
        reason: reason.trim() || undefined,
      })).unwrap();

      const successCount = result.results.filter((r: any) => r.success).length;

      if (result.task.success) {
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
      if (err?.task) setShowResults(true);
      if (err?.taskId) setQueryPaused(true);
      if (err?.code === 'TASK_ADMISSION_UNKNOWN') { setQueryPaused(true); setAdmissionUnknown(true); }
      notifyError(err?.code === 'TASK_ADMISSION_UNKNOWN' ? t('tasks.admissionUnknown') : err?.taskId ? t('tasks.queryPaused') : err?.message || t('calendar.approvalFailed'));
    }
  };

  const handleClose = () => {
    dispatch(clearBatchResults());
    setShowResults(false);
    onClose();
  };

  // When showing results after a batch submission with failures
  if (showResults && batchTask) {
    const failedResults = batchPunchResults.filter(r => !r.success && !r.unknown);
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
          <TaskResultSummary task={batchTask} />
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
      okButtonProps={{ disabled: selectedDates.length === 0 || batchPunchLoading || queryPaused || !timesReady }}
      width={520}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {!timesReady && <Alert type="warning" message={t('scheduleCard.invalidTime')} />}
        {queryPaused && <Alert type="warning" showIcon message={t(admissionUnknown ? 'tasks.admissionUnknown' : 'tasks.queryPaused')} />}
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
