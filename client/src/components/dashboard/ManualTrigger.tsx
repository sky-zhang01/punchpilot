import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button, Tag, Badge, Space, Typography, Modal, Spin } from 'antd';
import {
  LoginOutlined,
  LogoutOutlined,
  CoffeeOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import api from '../../api';
import { fetchStatus } from '../../store/statusSlice';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { notifySuccess, notifyError, notifyWarning } from '../../utils/notify';

const { Title, Text } = Typography;

// Color mapping for detected freee state
const STATE_COLORS: Record<string, string> = {
  not_checked_in: '#faad14',
  working: '#52c41a',
  on_break: '#1677ff',
  checked_out: '#8c8c8c',
  unknown: '#ff4d4f',
};

// Badge status mapping for the state indicator dot
const BADGE_STATUS: Record<string, 'warning' | 'success' | 'processing' | 'default' | 'error'> = {
  not_checked_in: 'warning',
  working: 'success',
  on_break: 'processing',
  checked_out: 'default',
  unknown: 'error',
};

const STATE_LABEL_KEYS: Record<string, string> = {
  not_checked_in: 'manualTrigger.stateNotCheckedIn',
  working: 'manualTrigger.stateWorking',
  on_break: 'manualTrigger.stateOnBreak',
  checked_out: 'manualTrigger.stateCheckedOut',
  unknown: 'manualTrigger.stateUnknown',
};

const HINT_KEYS: Record<string, string> = {
  not_checked_in: 'manualTrigger.hintNotCheckedIn',
  working: 'manualTrigger.hintWorking',
  on_break: 'manualTrigger.hintOnBreak',
  checked_out: 'manualTrigger.hintCheckedOut',
};

interface ActionConfig {
  type: string;
  labelKey: string;
  icon: React.ReactNode;
  color: string;
  validStates: string[];
}

const actions: ActionConfig[] = [
  {
    type: 'checkin',
    labelKey: 'actions.checkin',
    icon: <LoginOutlined />,
    color: '#52c41a',
    validStates: ['not_checked_in'],
  },
  {
    type: 'checkout',
    labelKey: 'actions.checkout',
    icon: <LogoutOutlined />,
    color: '#ff4d4f',
    validStates: ['working'],
  },
  {
    type: 'break_start',
    labelKey: 'actions.breakStart',
    icon: <CoffeeOutlined />,
    color: '#1677ff',
    validStates: ['working'],
  },
  {
    type: 'break_end',
    labelKey: 'actions.breakEnd',
    icon: <PlayCircleOutlined />,
    color: '#faad14',
    validStates: ['on_break'],
  },
];

interface ManualTriggerProps {
  onActionComplete?: () => void;
}

const ManualTrigger: React.FC<ManualTriggerProps> = ({ onActionComplete }) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [freeeState, setFreeeState] = useState('unknown');
  const [detecting, setDetecting] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);

  const detectState = useCallback(async () => {
    setDetecting(true);
    try {
      const res = await api.getFreeeState();
      setFreeeState(res.data.state || 'unknown');
    } catch {
      setFreeeState('unknown');
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    detectState();
  }, [detectState]);

  // Execute the action after confirmation
  const executeAction = async (action: ActionConfig) => {
    setExecuting(action.type);
    try {
      const res = await api.triggerAction(action.type);
      const data = res.data;

      if (data.status === 'skipped') {
        notifyWarning(
          t('manualTrigger.skipped', { action: t(action.labelKey), reason: data.reason || '' })
        );
      } else if (data.status === 'success') {
        notifySuccess(t('manualTrigger.success', { action: t(action.labelKey) }));
      } else {
        notifyError(
          t('manualTrigger.failed', { action: t(action.labelKey), error: data.error || '' })
        );
      }

      await detectState();
      dispatch(fetchStatus());
      onActionComplete?.();
    } catch (err: any) {
      notifyError(t('manualTrigger.error'));
    } finally {
      setExecuting(null);
    }
  };

  // Show confirmation dialog before executing an action
  const handleActionClick = (action: ActionConfig) => {
    const isValid = action.validStates.includes(freeeState);
    const actionLabel = t(action.labelKey);

    // Build the confirmation content with optional state mismatch warning
    const isStateMismatch = !isValid && freeeState !== 'unknown';
    const stateLabel = t(STATE_LABEL_KEYS[freeeState] || 'manualTrigger.stateUnknown');

    Modal.confirm({
      title: t('manualTrigger.confirmTitle'),
      icon: <ExclamationCircleOutlined />,
      content: isStateMismatch
        ? t('manualTrigger.stateWarning', { action: actionLabel, state: stateLabel })
        : t('manualTrigger.confirm', { action: actionLabel }),
      okText: isStateMismatch ? t('manualTrigger.executeAnyway') : t('manualTrigger.execute'),
      okType: isStateMismatch ? 'danger' : 'primary',
      cancelText: t('common.cancel'),
      onOk: () => executeAction(action),
    });
  };

  const stateColor = STATE_COLORS[freeeState] || STATE_COLORS.unknown;
  const badgeStatus = BADGE_STATUS[freeeState] || 'error';
  const stateLabelKey = STATE_LABEL_KEYS[freeeState] || STATE_LABEL_KEYS.unknown;
  const hintKey = HINT_KEYS[freeeState];

  return (
    <Card
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Title level={5} style={{ margin: 0 }}>
            {t('manualTrigger.title')}
          </Title>
          <Button
            type="text"
            icon={detecting ? <Spin size="small" /> : <ReloadOutlined />}
            onClick={detectState}
            disabled={detecting}
            size="small"
          />
        </div>
      }
    >
      {/* Current state display with Badge and Tag */}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space align="center">
          <Text type="secondary">{t('manualTrigger.currentState')}:</Text>
          <Badge status={badgeStatus} />
          <Tag
            color={stateColor}
            style={{ fontWeight: 600 }}
          >
            {detecting ? t('manualTrigger.detecting') : t(stateLabelKey)}
          </Tag>
        </Space>

        {/* Hint text for the current state */}
        {hintKey && !detecting && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t(hintKey)}
          </Text>
        )}

        {/* Action buttons in 2x2 grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {actions.map((action) => {
            const isValid = action.validStates.includes(freeeState);
            const isExecuting = executing === action.type;
            const isDimmed = !isValid && freeeState !== 'unknown';

            return (
              <Button
                key={action.type}
                type={isValid ? 'primary' : 'default'}
                icon={isExecuting ? <Spin size="small" /> : action.icon}
                disabled={!!executing || detecting}
                onClick={() => handleActionClick(action)}
                size="large"
                block
                style={{
                  height: 48,
                  ...(isValid
                    ? {
                        backgroundColor: action.color,
                        borderColor: action.color,
                      }
                    : {
                        color: action.color,
                        borderColor: action.color,
                        opacity: isDimmed ? 0.4 : 1,
                      }),
                }}
              >
                {t(action.labelKey)}
              </Button>
            );
          })}
        </div>
      </Space>
    </Card>
  );
};

export default ManualTrigger;
