import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, Badge, Tag, Typography, Space, Tooltip, Checkbox, Popover, Button } from 'antd';
import type { BadgeProps } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import api from '../../api';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { fetchAttendance, fetchApprovalRequests, withdrawApprovalRequest, toggleDateSelection } from '../../store/attendanceSlice';
import type { AttendanceRecord, ApprovalRequest } from '../../store/attendanceSlice';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Text } = Typography;

// Status-to-badge mapping
const STATUS_BADGE_MAP: Record<string, BadgeProps['status']> = {
  success: 'success',
  failure: 'error',
  skipped: 'warning',
};

interface HolidayInfo {
  date: string;
  name: string;
  country?: string; // 'jp', 'cn', 'custom'
}

interface WorkdayInfo {
  date: string;
  name: string; // e.g. "国庆节后补班" — the holiday name this workday compensates for
}

interface CalendarViewProps {
  calendarData?: Record<string, any[]>;
  onDateClick?: (date: string) => void;
  selectionMode?: boolean;
  leaveSelectionMode?: boolean; // When true, all dates (past/today/future) are selectable for leave requests
  refreshKey?: number;
}

const CalendarView: React.FC<CalendarViewProps> = ({
  calendarData: externalData,
  onDateClick,
  selectionMode = false,
  leaveSelectionMode = false,
  refreshKey = 0,
}) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { connectionMode, oauthConfigured, schedules, holidaySkipCountries } = useAppSelector((state) => state.config);
  const { records: attendanceRecords, selectedDates, approvalRequests } = useAppSelector((state) => state.attendance);

  const [currentDate, setCurrentDate] = useState<Dayjs>(dayjs());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [calendarData, setCalendarData] = useState<Record<string, any[]>>({});
  const [holidayMap, setHolidayMap] = useState<Record<string, HolidayInfo[]>>({});
  const [workdayMap, setWorkdayMap] = useState<Record<string, WorkdayInfo>>({});
  const [maxHolidayYear, setMaxHolidayYear] = useState<number>(dayjs().year() + 1);

  // Countries selected for auto-punch skip — only these get holiday background colors
  const skipSet = new Set((holidaySkipCountries || 'jp').split(',').map(c => c.trim()).filter(Boolean));

  // Fetch punch logs for the current month (local logs)
  const fetchLogs = useCallback(async () => {
    try {
      const year = currentDate.year();
      const month = currentDate.month() + 1;
      const res = await api.getCalendarData(year, month);
      setCalendarData(res.data.days || {});
    } catch {
      setCalendarData({});
    }
  }, [currentDate]);

  // Fetch freee attendance records + approval requests via Redux
  const fetchAttendanceData = useCallback(async () => {
    if (!oauthConfigured) return;
    const year = currentDate.year();
    const month = currentDate.month() + 1;
    dispatch(fetchAttendance({ year, month }));
    dispatch(fetchApprovalRequests({ year, month }));
  }, [currentDate, oauthConfigured, dispatch]);

  // Fetch holidays for both JP and CN for the current year
  const fetchHolidays = useCallback(async () => {
    const year = currentDate.year();
    const map: Record<string, HolidayInfo[]> = {};

    try {
      const jpRes = await api.getHolidays({ year, country: 'jp' });
      for (const h of jpRes.data.national || []) {
        if (!map[h.date]) map[h.date] = [];
        map[h.date].push({ date: h.date, name: h.name, country: 'jp' });
      }
    } catch { /* silent */ }

    try {
      const cnRes = await api.getHolidays({ year, country: 'cn' });
      for (const h of cnRes.data.national || []) {
        if (!map[h.date]) map[h.date] = [];
        map[h.date].push({ date: h.date, name: h.name, country: 'cn' });
      }
    } catch { /* silent */ }

    try {
      const customRes = await api.getHolidays({ year, country: 'jp' });
      for (const h of customRes.data.custom || []) {
        if (!map[h.date]) map[h.date] = [];
        map[h.date].push({ date: h.date, name: h.description || h.name, country: 'custom' });
      }
    } catch { /* silent */ }

    // Fetch CN 调休 (makeup workday) data
    const wdMap: Record<string, WorkdayInfo> = {};
    try {
      const wdRes = await api.getCnWorkdays(year);
      for (const wd of wdRes.data.workdays || []) {
        wdMap[wd.date] = { date: wd.date, name: wd.name };
      }
    } catch { /* silent */ }

    setHolidayMap(map);
    setWorkdayMap(wdMap);
  }, [currentDate]);

  useEffect(() => {
    if (externalData) {
      setCalendarData(externalData);
    } else {
      fetchLogs();
    }
    fetchHolidays();
    fetchAttendanceData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalData, fetchLogs, fetchHolidays, fetchAttendanceData, refreshKey]);

  // Auto-refresh attendance data every 60s so Calendar reflects auto-punch results
  useEffect(() => {
    if (!oauthConfigured) return;
    const interval = setInterval(() => {
      fetchAttendanceData();
      if (!externalData) fetchLogs();
    }, 60000);
    return () => clearInterval(interval);
  }, [oauthConfigured, fetchAttendanceData, fetchLogs, externalData]);

  // Determine calendar valid range based on actual holiday data availability
  useEffect(() => {
    (async () => {
      try {
        const [jpRes, cnRes] = await Promise.all([
          api.getHolidayAvailableYears('jp'),
          api.getHolidayAvailableYears('cn'),
        ]);
        const jpYears = jpRes.data.years || [];
        const cnYears = cnRes.data.years || [];
        const allYears = [...jpYears, ...cnYears];
        if (allYears.length > 0) {
          setMaxHolidayYear(Math.max(...allYears));
        }
      } catch { /* fallback to default */ }
    })();
  }, []);

  const isWeekend = (date: Dayjs): boolean => {
    const day = date.day();
    return day === 0 || day === 6;
  };

  // Holiday tag color by country: CN=red(国旗), JP=pink(樱花)
  const getHolidayTagColor = (country?: string) => {
    switch (country) {
      case 'jp': return 'magenta'; // sakura pink
      case 'cn': return 'red';     // Chinese flag red
      case 'custom': return 'purple';
      default: return 'blue';
    }
  };

  const getHolidayTagLabel = (country?: string) => {
    switch (country) {
      case 'jp': return '\u{1F1EF}\u{1F1F5}';
      case 'cn': return '\u{1F1E8}\u{1F1F3}';
      case 'custom': return '\u2B50';
      default: return '\u{1F4C5}';
    }
  };

  const formatTime = (timeStr: string | null): string => {
    if (!timeStr) return '--:--';
    if (timeStr.includes('T')) {
      return dayjs(timeStr).format('HH:mm');
    }
    return timeStr;
  };

  const isCurrentMonth = (date: Dayjs): boolean => {
    return date.month() === currentDate.month() && date.year() === currentDate.year();
  };

  // Check if today is past the auto check-in window end time
  const isTodayPastCheckinTime = useCallback((): boolean => {
    const checkinSchedule = schedules.find(s => s.action_type === 'checkin');
    if (!checkinSchedule) return false;
    const endTime = checkinSchedule.mode === 'random' ? checkinSchedule.window_end : checkinSchedule.fixed_time;
    if (!endTime) return false;
    const [h, m] = endTime.split(':').map(Number);
    const now = dayjs();
    return now.hour() > h || (now.hour() === h && now.minute() >= m);
  }, [schedules]);

  // Check if a date is a missing punch day (workday with no clock-in, not absence, not holiday, no pending/approved approval)
  // Includes today if past check-in window time and no records
  const isMissingPunch = (dateKey: string, attendance: AttendanceRecord | undefined): boolean => {
    const today = dayjs().format('YYYY-MM-DD');
    if (dateKey > today) return false; // Future dates not missing
    if (dateKey === today && !isTodayPastCheckinTime()) return false; // Today but not past check-in time yet
    if (!attendance) return false;
    // Skip if there's a pending or approved approval request for this date
    const approval = approvalRequests[dateKey];
    if (approval && (approval.status === 'in_progress' || approval.status === 'approved')) return false;
    return (
      attendance.day_pattern === 'normal_day' &&
      !attendance.clock_in &&
      !attendance.is_absence &&
      !attendance.is_holiday
    );
  };

  // Check if a date is selectable for batch punch or leave request
  const isSelectable = (dateKey: string): boolean => {
    if (leaveSelectionMode) {
      // In leave selection mode, exclude:
      // 1. Dates that already have punch records (clock_in exists)
      // 2. Dates with approved approval requests
      // 3. Public holidays
      const attendance = attendanceRecords[dateKey];
      if (attendance?.clock_in) return false; // Already punched in
      const approval = approvalRequests[dateKey];
      if (approval?.status === 'approved') return false; // Already approved
      const holidays = holidayMap[dateKey] || [];
      if (holidays.some(h => h.country === 'jp' || h.country === 'cn')) return false; // Public holiday
      return true;
    }
    const attendance = attendanceRecords[dateKey];
    return isMissingPunch(dateKey, attendance);
  };

  // Whether any selection mode is active
  const anySelectionMode = selectionMode || leaveSelectionMode;

  // Check if a date has holidays from skip-selected countries (affects background color)
  const getSkippedHolidays = (holidays: HolidayInfo[]): HolidayInfo[] => {
    return holidays.filter(h => h.country && skipSet.has(h.country));
  };

  // Get the primary holiday country for a date (for background color priority)
  // Only considers skip-selected countries
  const getPrimaryHolidayCountry = (holidays: HolidayInfo[]): string | null => {
    const skipped = getSkippedHolidays(holidays);
    if (skipped.length === 0) return null;
    if (skipped.some(h => h.country === 'cn')) return 'cn';
    if (skipped.some(h => h.country === 'jp')) return 'jp';
    return 'custom';
  };

  // Determine cell style with new color design
  const getCellStyle = (date: Dayjs): React.CSSProperties => {
    const dateKey = date.format('YYYY-MM-DD');
    const dayLogs = calendarData[dateKey] || [];
    const holidays = holidayMap[dateKey] || [];
    const attendance = attendanceRecords[dateKey];
    const todayStr = dayjs().format('YYYY-MM-DD');
    const isToday = dateKey === todayStr;
    const isSelected = dateKey === selectedDate && dateKey !== todayStr;
    const weekend = isWeekend(date);
    const inCurrentMonth = isCurrentMonth(date);
    const missing = isMissingPunch(dateKey, attendance);

    const style: React.CSSProperties = {
      minHeight: 60,
      padding: 4,
      borderRadius: 6,
      position: 'relative',
      transition: 'background-color 0.15s',
    };

    // Dim dates from other months
    if (!inCurrentMonth) {
      style.opacity = 0.35;
    }

    // Missing punch: red dashed border + light red background
    if (missing && inCurrentMonth) {
      style.border = '2px dashed rgba(255, 77, 79, 0.6)';
      style.backgroundColor = 'rgba(255, 77, 79, 0.06)';
    }

    // Selection mode highlight (batch punch or leave selection)
    if (anySelectionMode && selectedDates.includes(dateKey)) {
      style.backgroundColor = leaveSelectionMode ? 'rgba(82, 196, 26, 0.12)' : 'rgba(22, 119, 255, 0.12)';
      style.border = leaveSelectionMode ? '2px solid rgba(82, 196, 26, 0.5)' : '2px solid rgba(22, 119, 255, 0.5)';
    }

    // Today: yolk yellow background + border
    if (isToday && inCurrentMonth) {
      style.backgroundColor = 'var(--pp-cal-today-bg)';
      style.border = '2px solid var(--pp-cal-today-border)';
    }
    // Selected (non-today): blue highlight
    else if (isSelected && inCurrentMonth && !anySelectionMode) {
      style.backgroundColor = 'var(--pp-cal-selected-bg)';
      style.border = '2px solid var(--pp-cal-selected-border)';
    }

    // Holiday background — only for skip-selected countries (those affect auto-punch)
    if (holidays.length > 0) {
      const primary = getPrimaryHolidayCountry(holidays);
      if (primary) {
        // This holiday is from a skip-selected country → show holiday background
        if (primary === 'cn') {
          style.backgroundColor = 'var(--pp-cal-holiday-cn-bg)';
        } else {
          style.backgroundColor = 'var(--pp-cal-holiday-jp-bg)';
        }
        return style;
      }
      // Holidays exist but none are skip-selected → fall through to normal coloring
    }

    // Weekend: gray background
    // Skip gray if: 调休 workday AND cn is in skip set (auto-punch treats it as workday)
    const isTiaoxiuWorkday = !!(workdayMap[dateKey] && skipSet.has('cn'));
    if (weekend && !isTiaoxiuWorkday) {
      if (!isToday && !isSelected) {
        style.backgroundColor = 'var(--pp-cal-weekend-bg)';
      }
      return style;
    }

    // Skip coloring if today/selected already set
    if (isToday || isSelected) return style;

    // Freee attendance data coloring (only if not missing punch)
    if (attendance && !missing) {
      if (attendance.clock_in && attendance.clock_out) {
        style.backgroundColor = 'rgba(82, 196, 26, 0.12)';
      } else if (attendance.clock_in && !attendance.clock_out) {
        style.backgroundColor = 'rgba(250, 173, 20, 0.12)';
      }
      return style;
    }

    // Local logs coloring
    if (dayLogs.length > 0 && !attendance) {
      const hasError = dayLogs.some((l: any) => l.status === 'failure');
      if (hasError) {
        style.backgroundColor = 'rgba(255, 77, 79, 0.12)';
        return style;
      }
      const hasCheckin = dayLogs.some((l: any) => l.action_type === 'checkin');
      const hasCheckout = dayLogs.some((l: any) => l.action_type === 'checkout');
      if (hasCheckin && hasCheckout) {
        style.backgroundColor = 'rgba(82, 196, 26, 0.12)';
      } else if (hasCheckin && !hasCheckout) {
        style.backgroundColor = 'rgba(250, 173, 20, 0.12)';
      }
    }

    return style;
  };

  // Approval request status helpers
  const getApprovalTagColor = (status: string): string => {
    switch (status) {
      case 'in_progress': return 'gold';
      case 'approved': return 'green';
      case 'feedback': return 'red';
      default: return 'default';
    }
  };

  const getApprovalTagLabel = (status: string): string => {
    switch (status) {
      case 'in_progress': return t('calendar.approvalPending');
      case 'approved': return t('calendar.approvalApproved');
      case 'feedback': return t('calendar.approvalRejected');
      default: return status;
    }
  };

  const handleWithdraw = async (id: number) => {
    try {
      await dispatch(withdrawApprovalRequest(id)).unwrap();
      notifySuccess(t('calendar.withdrawSuccess'));
    } catch (err: any) {
      notifyError(err?.message || t('common.error'));
    }
  };

  const renderApprovalPopoverContent = (approval: ApprovalRequest) => {
    const wr = approval.work_records?.[0];
    const br = approval.break_records?.[0];
    return (
      <div style={{ maxWidth: 240 }}>
        <div style={{ marginBottom: 4 }}>
          <Text strong style={{ fontSize: 12 }}>{approval.target_date}</Text>
          {approval.request_number && (
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>#{approval.request_number}</Text>
          )}
        </div>
        {wr && (
          <div style={{ fontSize: 11, marginBottom: 2 }}>
            {formatTime(wr.clock_in_at)} - {formatTime(wr.clock_out_at)}
          </div>
        )}
        {br && (
          <div style={{ fontSize: 11, color: '#8c8c8c', marginBottom: 2 }}>
            {t('calendar.break')}: {formatTime(br.clock_in_at)} - {formatTime(br.clock_out_at)}
          </div>
        )}
        {approval.comment && (
          <div style={{ fontSize: 11, color: '#8c8c8c', marginBottom: 4 }}>{approval.comment}</div>
        )}
        {approval.status === 'in_progress' && (
          <Button
            danger
            size="small"
            style={{ fontSize: 11, marginTop: 4 }}
            onClick={(e) => { e.stopPropagation(); handleWithdraw(approval.id); }}
          >
            {t('calendar.withdrawApproval')}
          </Button>
        )}
      </div>
    );
  };

  // Cell render
  const cellRender = (date: Dayjs, info: { type: string }) => {
    if (info.type !== 'date') return null;

    const dateKey = date.format('YYYY-MM-DD');
    const dayLogs = calendarData[dateKey] || [];
    const holidays = holidayMap[dateKey] || [];
    const workday = workdayMap[dateKey];
    const attendance = attendanceRecords[dateKey];
    const approval = approvalRequests[dateKey];
    const weekend = isWeekend(date);
    const missing = isMissingPunch(dateKey, attendance);
    const inCurrentMonth = isCurrentMonth(date);

    return (
      <div style={getCellStyle(date)}>
        {/* Selection checkbox (batch punch or leave selection) */}
        {anySelectionMode && inCurrentMonth && isSelectable(dateKey) && (
          <Checkbox
            checked={selectedDates.includes(dateKey)}
            onChange={(e) => {
              e.stopPropagation();
              dispatch(toggleDateSelection(dateKey));
            }}
            style={{ position: 'absolute', top: 2, right: 2, zIndex: 2 }}
            onClick={(e) => e.stopPropagation()}
          />
        )}

        {/* Weekend label — hide if: has holidays, or is 调休 workday with cn skip-selected */}
        {weekend && holidays.length === 0 && !(workday && skipSet.has('cn')) && (
          <Text type="secondary" style={{ fontSize: 10, fontWeight: 600 }}>
            {date.day() === 0 ? t('calendar.sun') : t('calendar.sat')}
          </Text>
        )}

        {/* CN 调休 makeup workday tag */}
        {workday && (
          <Tooltip title={workday.name}>
            <Tag
              color="orange"
              style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0, marginBottom: 2 }}
            >
              {'\u{1F1E8}\u{1F1F3}'} {t('holidays.cnWorkday')}
            </Tag>
          </Tooltip>
        )}

        {/* Holiday tags */}
        {holidays.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 2 }}>
            {holidays.map((h, i) => (
              <Tag
                key={i}
                color={getHolidayTagColor(h.country)}
                style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}
                title={h.name}
              >
                {getHolidayTagLabel(h.country)} {h.name.length > 6 ? h.name.slice(0, 6) + '\u2026' : h.name}
              </Tag>
            ))}
          </div>
        )}

        {/* Approval request status tag */}
        {approval && inCurrentMonth && (
          <Popover
            content={renderApprovalPopoverContent(approval)}
            trigger="click"
            placement="right"
          >
            <Tag
              color={getApprovalTagColor(approval.status)}
              style={{ fontSize: 9, lineHeight: '14px', padding: '0 3px', margin: 0, cursor: 'pointer' }}
              onClick={(e) => e.stopPropagation()}
            >
              {getApprovalTagLabel(approval.status)}
            </Tag>
          </Popover>
        )}

        {/* Freee attendance record */}
        {attendance && (attendance.clock_in || attendance.clock_out) && (
          <Tooltip title={`${t('calendar.workMins')}: ${attendance.total_work_mins}min`}>
            <div style={{ fontSize: 10, lineHeight: '14px', color: '#52c41a', fontWeight: 500 }}>
              {formatTime(attendance.clock_in)} - {formatTime(attendance.clock_out)}
            </div>
          </Tooltip>
        )}

        {/* Approval request time display (when no freee attendance record exists) */}
        {approval && !attendance?.clock_in && approval.work_records?.[0] && (
          <div style={{ fontSize: 10, lineHeight: '14px', color: '#faad14', fontWeight: 500 }}>
            {formatTime(approval.work_records[0].clock_in_at)} - {formatTime(approval.work_records[0].clock_out_at)}
          </div>
        )}

        {/* Break time display */}
        {attendance && attendance.break_records && attendance.break_records.length > 0 && (
          <div style={{ fontSize: 9, lineHeight: '12px', color: '#8c8c8c' }}>
            {attendance.break_records.map((br, i) => (
              <div key={i}>
                {t('calendar.break')}: {formatTime(br.clock_in)} - {formatTime(br.clock_out)}
              </div>
            ))}
          </div>
        )}

        {/* Missing punch indicator */}
        {missing && inCurrentMonth && (
          <Text style={{ fontSize: 9, color: '#ff4d4f', fontWeight: 500 }}>
            {t('calendar.legendMissing')}
          </Text>
        )}

        {/* Punch log badges (local logs) */}
        {dayLogs.length > 0 && !attendance && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            {dayLogs.map((log: any, idx: number) => {
              const badgeStatus = STATUS_BADGE_MAP[log.status] || 'default';
              const actionLabel = t(`actions.${log.action_type?.replace('_', '')}`);
              return (
                <Badge
                  key={idx}
                  status={badgeStatus}
                  text={<Text style={{ fontSize: 11 }}>{actionLabel.charAt(0)}</Text>}
                />
              );
            })}
          </div>
        )}

        {/* Both attendance and local logs */}
        {dayLogs.length > 0 && attendance && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1, marginTop: 1 }}>
            {dayLogs.map((log: any, idx: number) => {
              const badgeStatus = STATUS_BADGE_MAP[log.status] || 'default';
              return <Badge key={idx} status={badgeStatus} />;
            })}
          </div>
        )}
      </div>
    );
  };

  const handlePanelChange = (date: Dayjs) => {
    setCurrentDate(date);
  };

  const handleSelect = (date: Dayjs) => {
    const dateStr = date.format('YYYY-MM-DD');

    // In selection mode (batch punch or leave) — toggle checkbox via cell click
    if (anySelectionMode) {
      if (isSelectable(dateStr)) {
        dispatch(toggleDateSelection(dateStr));
      }
      return;
    }

    // Non-selection mode: toggle selected date
    if (selectedDate === dateStr) {
      setSelectedDate(null);
      if (onDateClick) {
        onDateClick('');
      }
    } else {
      setSelectedDate(dateStr);
      setCurrentDate(date);
      if (onDateClick) {
        onDateClick(dateStr);
      }
    }
  };

  // Legend
  const legend = (
    <Space size="middle" wrap style={{ marginBottom: 12, fontSize: 12 }}>
      <Space size={4}>
        <div style={{ width: 14, height: 14, backgroundColor: 'var(--pp-cal-today-bg)', borderRadius: 3, border: '2px solid var(--pp-cal-today-border)' }} />
        <Text type="secondary">{t('calendar.legendToday')}</Text>
      </Space>
      <Space size={4}>
        <div style={{ width: 14, height: 14, backgroundColor: 'var(--pp-cal-selected-bg)', borderRadius: 3, border: '2px solid var(--pp-cal-selected-border)' }} />
        <Text type="secondary">{t('calendar.legendSelected')}</Text>
      </Space>
      <Space size={4}>
        <div style={{ width: 14, height: 14, backgroundColor: 'rgba(82, 196, 26, 0.3)', borderRadius: 3 }} />
        <Text type="secondary">{t('calendar.legendComplete')}</Text>
      </Space>
      <Space size={4}>
        <div style={{ width: 14, height: 14, backgroundColor: 'rgba(250, 173, 20, 0.3)', borderRadius: 3 }} />
        <Text type="secondary">{t('calendar.legendPartial')}</Text>
      </Space>
      <Space size={4}>
        <div style={{ width: 14, height: 14, backgroundColor: 'rgba(255, 77, 79, 0.06)', borderRadius: 3, border: '2px dashed rgba(255, 77, 79, 0.6)' }} />
        <Text type="secondary">{t('calendar.legendMissing')}</Text>
      </Space>
      <Space size={4}>
        <div style={{ width: 14, height: 14, backgroundColor: 'var(--pp-cal-weekend-bg)', borderRadius: 3, border: '1px solid rgba(0,0,0,0.1)' }} />
        <Text type="secondary">{t('calendar.legendWeekend')}</Text>
      </Space>
      <Space size={4}>
        <Tag color="magenta" style={{ fontSize: 10, lineHeight: '14px', padding: '0 3px' }}>{'\u{1F1EF}\u{1F1F5}'}</Tag>
        <Text type="secondary">{t('holidays.countryJp')}</Text>
      </Space>
      <Space size={4}>
        <Tag color="red" style={{ fontSize: 10, lineHeight: '14px', padding: '0 3px' }}>{'\u{1F1E8}\u{1F1F3}'}</Tag>
        <Text type="secondary">{t('holidays.countryCn')}</Text>
      </Space>
      <Space size={4}>
        <Tag color="orange" style={{ fontSize: 10, lineHeight: '14px', padding: '0 3px' }}>{'\u{1F1E8}\u{1F1F3}'}</Tag>
        <Text type="secondary">{t('holidays.cnWorkday')}</Text>
      </Space>
      {oauthConfigured && (
        <Space size={4}>
          <Text style={{ fontSize: 10, color: '#52c41a' }}>09:00-18:00</Text>
          <Text type="secondary">{t('calendar.legendFreee')}</Text>
        </Space>
      )}
    </Space>
  );

  return (
    <div>
      {legend}
      <Calendar
        value={currentDate}
        onPanelChange={handlePanelChange}
        onSelect={handleSelect}
        cellRender={cellRender}
        validRange={[dayjs().subtract(1, 'year').startOf('year'), dayjs().year(maxHolidayYear).endOf('year')]}
        style={{ borderRadius: 8 }}
      />
    </div>
  );
};

export default CalendarView;
