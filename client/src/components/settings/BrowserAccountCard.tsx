import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Form, Input, Button, Tag, Alert, Typography, Space } from 'antd';
import {
  LockOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
} from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { saveAccount, clearAccount, fetchConfig } from '../../store/configSlice';
import api from '../../api';
import { notifySuccess, notifyError, notifyWarning } from '../../utils/notify';

const { Title, Text } = Typography;

const BrowserAccountCard: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { freeeConfigured, freeeUsername, webIdentityVerified } = useAppSelector(
    (state) => state.config,
  );

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [envUsername, setEnvUsername] = useState('');
  const webCredentialsAvailable = freeeConfigured || Boolean(envUsername);

  useEffect(() => {
    api
      .getAccount()
      .then((res) => {
        if (res.data.freee_username) setUsername(res.data.freee_username);
        if (res.data.freee_company_name) setCompanyName(res.data.freee_company_name);
        if (res.data.has_env_credentials) setEnvUsername(res.data.env_username);
      })
      .catch(() => {});
  }, []);

  // Save → instant feedback → then auto-verify in background
  const handleSave = async () => {
    if (!username.trim() || !password) {
      notifyWarning(t('settings.enterBoth'));
      return;
    }
    if (!companyName.trim()) {
      notifyWarning(t('settings.enterWebCompany'));
      return;
    }
    setSaving(true);
    try {
      await dispatch(saveAccount({
        username: username.trim(),
        password,
        companyName: companyName.trim(),
      })).unwrap();
      setPassword('');
      notifySuccess(t('settings.credsSaved'));
      setSaving(false);

      // Auto-verify after save — user sees "Verifying..." state
      setVerifying(true);
      try {
        const res = await api.verifyWebCredentials();
        await dispatch(fetchConfig());
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
    try {
      await dispatch(clearAccount()).unwrap();
      setUsername('');
      setPassword('');
      setCompanyName('');
      notifySuccess(t('settings.credsCleared'));
    } catch (error: any) {
      notifyError(error?.response?.data?.error || t('common.error'));
    }
  };

  // Verify connection — separate action, checks res.data.valid (matches backend)
  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await api.verifyWebCredentials();
      await dispatch(fetchConfig());
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
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {/* Header with status tag */}
        <Space align="center">
          <Title level={5} style={{ margin: 0 }}>
            {t('settings.webAccountTitle')}
          </Title>
          {webCredentialsAvailable && webIdentityVerified ? (
            <Tag icon={<CheckCircleFilled />} color="success">
              {t('settings.configured')}
            </Tag>
          ) : webCredentialsAvailable ? (
            <Tag icon={<CloseCircleFilled />} color="warning">
              {t('settings.verify')}
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

        {webCredentialsAvailable && companyName && (
          <Space size={8} align="center">
            <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.oauthCompany')}:</Text>
            <Text code style={{ fontSize: 12 }}>{companyName}</Text>
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
          <Form.Item label={t('settings.oauthCompany')}>
            <Input
              placeholder={t('settings.webCompanyPlaceholder')}
              value={companyName}
              maxLength={200}
              onChange={(e) => setCompanyName(e.target.value)}
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
            disabled={verifying || !webCredentialsAvailable}
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
