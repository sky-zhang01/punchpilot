import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Switch, Alert, Typography, Space } from 'antd';
import { BugOutlined } from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { toggleDebug } from '../../store/configSlice';
import { notifySuccess, notifyError } from '../../utils/notify';

const { Title } = Typography;

const MockModeCard: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { debugMode, autoEnabled } = useAppSelector((state) => state.config);

  const handleToggle = async () => {
    try {
      const result = await dispatch(toggleDebug()).unwrap();
      notifySuccess(result.debug_mode ? t('settings.mockEnabled') : t('settings.mockDisabled'));
    } catch {
      notifyError(t('common.error'));
    }
  };

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Header with toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space align="center">
            <BugOutlined />
            <Title level={5} style={{ margin: 0 }}>
              {t('settings.mockTitle')}
            </Title>
          </Space>
          <Switch checked={debugMode} onChange={handleToggle} />
        </div>

        {/* Status alert */}
        <Alert
          type={debugMode ? 'warning' : 'info'}
          showIcon
          message={debugMode ? t('settings.debugOn') : t('settings.debugOff')}
        />

        {/* Auto-disabled notice */}
        {!autoEnabled && (
          <Alert type="info" showIcon message={t('settings.autoDisabled')} />
        )}
      </Space>
    </Card>
  );
};

export default MockModeCard;
