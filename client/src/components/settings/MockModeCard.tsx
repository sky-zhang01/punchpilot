import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Switch, Alert, Typography, Space } from 'antd';
import { BugOutlined } from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { toggleDebug } from '../../store/configSlice';
import { notifySuccess } from '../../utils/notify';

const { Title } = Typography;

const MockModeCard: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { debugMode, autoEnabled } = useAppSelector((state) => state.config);

  const handleToggle = async () => {
    await dispatch(toggleDebug());
    notifySuccess(debugMode ? t('settings.mockDisabled') : t('settings.mockEnabled'));
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
