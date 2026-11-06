import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Descriptions, Typography, Spin, Empty } from 'antd';
import { useAppSelector } from '../../store/hooks';

const { Title } = Typography;

const formatMins = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

const MonthlySummary: React.FC = () => {
  const { t } = useTranslation();
  const { summary, loading } = useAppSelector((state) => state.attendance);

  if (loading) {
    return (
      <Card>
        <Spin />
      </Card>
    );
  }

  if (!summary) {
    return null;
  }

  return (
    <Card>
      <Title level={5} style={{ marginTop: 0, marginBottom: 16 }}>
        {t('calendar.monthlySummaryTitle')}
      </Title>
      <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small" bordered>
        <Descriptions.Item label={t('calendar.summaryWorkDays')}>
          {summary.work_days}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryTotalWork')}>
          {formatMins(summary.total_work_mins)}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryNormalWork')}>
          {formatMins(summary.total_normal_work_mins)}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryOvertime')}>
          {formatMins(summary.total_overtime_work_mins)}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryHolidayWork')}>
          {formatMins(summary.total_holiday_work_mins)}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryLatenight')}>
          {formatMins(summary.total_latenight_work_mins)}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryAbsences')}>
          {summary.num_absences}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryPaidHoliday')}>
          {summary.num_paid_holidays_and_hours
            ? `${summary.num_paid_holidays_and_hours.days}d ${summary.num_paid_holidays_and_hours.hours}h`
            : summary.num_paid_holidays}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryRemainingPaidHoliday')}>
          {summary.num_paid_holidays_and_hours_left
            ? `${summary.num_paid_holidays_and_hours_left.days}d ${summary.num_paid_holidays_and_hours_left.hours}h`
            : summary.num_paid_holidays_left}
        </Descriptions.Item>
        <Descriptions.Item label={t('calendar.summaryLatenessEarlyLeaving')}>
          {formatMins(summary.total_lateness_and_early_leaving_mins)}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
};

export default MonthlySummary;
