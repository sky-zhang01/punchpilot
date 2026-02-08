import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Radio, Alert, Typography } from 'antd';
import type { RadioChangeEvent } from 'antd';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { setConnectionMode, fetchConfig } from '../../store/configSlice';
import { notifySuccess } from '../../utils/notify';

const { Title } = Typography;

const ConnectionModeCard: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { connectionMode } = useAppSelector((state) => state.config);

  const handleChange = async (e: RadioChangeEvent) => {
    const mode = e.target.value as string;
    await dispatch(setConnectionMode(mode));
    // Refresh full config state after mode change (fixes BUG-5)
    await dispatch(fetchConfig());
    notifySuccess(t('settings.modeChanged'));
  };

  return (
    <Card>
      <Title level={5} style={{ marginBottom: 16 }}>
        {t('settings.connectionModeTitle')}
      </Title>

      <Radio.Group value={connectionMode} onChange={handleChange}>
        <Radio value="browser">{t('settings.modeBrowser')}</Radio>
        <Radio value="api">{t('settings.modeApi')}</Radio>
      </Radio.Group>

      <Alert
        type="info"
        showIcon
        message={
          connectionMode === 'browser'
            ? t('settings.browserModeHint')
            : t('settings.apiModeHint')
        }
        style={{ marginTop: 16 }}
      />
    </Card>
  );
};

export default ConnectionModeCard;
