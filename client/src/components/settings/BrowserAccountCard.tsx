import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Form, Input, Button, Tag, Alert, Typography, Space } from 'antd';
import {
  LockOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
} from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { saveAccount, clearAccount } from '../../store/configSlice';
import api from '../../api';
import { notifySuccess, notifyError, notifyWarning } from '../../utils/notify';

const { Title, Text } = Typography;

const BrowserAccountCard: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { freeeConfigured, freeeUsername } = useAppSelector((state) => state.config);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [envUsername, setEnvUsername] = useState('');

  useEffect(() => {
    api
      .getAccount()
      .then((res) => {
        if (res.data.username) {
          setUsername(res.data.username);
          if (res.data.source === 'env') setEnvUsername(res.data.username);
        }
      })
      .catch(() => {});
  }, []);

  // Save → instant feedback → then auto-verify in background
  const handleSave = async () => {
    if (!username.trim() || !password) {
      notifyWarning(t('settings.enterBoth'));
      return;
    }
    setSaving(true);
    try {
      await dispatch(saveAccount({ username: username.trim(), password })).unwrap();
      setPassword('');
      notifySuccess(t('settings.credsSaved'));
      setSaving(false);

      // Auto-verify after save — user sees "Verifying..." state
      setVerifying(true);
      try {
        const res = await api.verifyCredentials();
        if (res.data.valid) {
          notifySuccess(t('settings.verifySuccess'));
        } else {
          notifyError(res.data.error || t('settings.verifyFailed'));
        }
      } catch (verifyErr: any) {
        notifyError(verifyErr?.response?.data?.error || t('settings.verifyFailed'));
      } finally {
        setVerifying(false);
      }
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
      setSaving(false);
    }
  };

  const handleClear = async () => {
    await dispatch(clearAccount());
    setUsername('');
    setPassword('');
    notifySuccess(t('settings.credsCleared'));
  };

  // Verify connection — separate action, checks res.data.valid (matches backend)
  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await api.verifyCredentials();
      if (res.data.valid) {
        notifySuccess(t('settings.verifySuccess'));
      } else {
        notifyError(res.data.error || t('settings.verifyFailed'));
      }
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('settings.verifyFailed'));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Header with status tag */}
        <Space align="center">
          <Title level={5} style={{ margin: 0 }}>
            {t('settings.webAccountTitle')}
          </Title>
          {freeeConfigured ? (
            <Tag icon={<CheckCircleFilled />} color="success">
              {t('settings.configured')}
            </Tag>
          ) : (
            <Tag icon={<CloseCircleFilled />} color="error">
              {t('settings.notConfigured')}
            </Tag>
          )}
        </Space>

        {/* Explanation of web automation purpose */}
        <Alert
          type="info"
          showIcon
          message={t('settings.webAccountDesc')}
        />

        {/* Env username notice */}
        {envUsername && (
          <Alert
            type="info"
            showIcon
            message={t('settings.envCredentials', { username: envUsername })}
          />
        )}

        {/* Show saved username when configured */}
        {freeeConfigured && freeeUsername && (
          <Space size={8} align="center">
            <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.savedUsername')}:</Text>
            <Text code style={{ fontSize: 12 }}>{freeeUsername}</Text>
          </Space>
        )}

        {/* Credentials form */}
        <Form layout="vertical" size="middle">
          <Form.Item label={t('settings.username')}>
            <Input
              placeholder={t('settings.usernamePlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Form.Item>
          <Form.Item label={t('settings.password')}>
            <Input.Password
              placeholder={t('settings.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Form.Item>
        </Form>

        {/* Action buttons */}
        <Space wrap>
          <Button type="primary" onClick={handleSave} loading={saving}>
            {t('settings.saveCredentials')}
          </Button>
          <Button
            onClick={handleVerify}
            disabled={verifying || !freeeConfigured}
            loading={verifying}
          >
            {verifying ? t('settings.verifying') : t('settings.verify')}
          </Button>
          {freeeConfigured && (
            <Button danger onClick={handleClear}>
              {t('settings.clear')}
            </Button>
          )}
        </Space>

        {/* Encryption notice */}
        <Space size={4} align="center">
          <LockOutlined style={{ fontSize: 14, color: '#94a3b8' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('settings.encryption')}
          </Text>
        </Space>
      </Space>
    </Card>
  );
};

export default BrowserAccountCard;
