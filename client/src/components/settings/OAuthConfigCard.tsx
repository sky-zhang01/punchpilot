import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Form,
  Input,
  Button,
  Steps,
  Tag,
  Alert,
  Typography,
  Space,
  Descriptions,
  Select,
} from 'antd';
import {
  LockOutlined,
  LinkOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
} from '@ant-design/icons';
import api from '../../api';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { fetchConfig } from '../../store/configSlice';
import { notifySuccess, notifyError, notifyWarning } from '../../utils/notify';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const OAuthConfigCard: React.FC = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { oauthConfigured } = useAppSelector((state) => state.config);

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [oauthStatus, setOauthStatus] = useState<any>(null);
  const [employeeInfo, setEmployeeInfo] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);

  const loadOAuthStatus = useCallback(async () => {
    try {
      const res = await api.getOAuthStatus();
      setOauthStatus(res.data);
    } catch {}
  }, []);

  // Fetch richer employee info (department, position, etc.)
  const loadEmployeeInfo = useCallback(async () => {
    try {
      const res = await api.getEmployeeInfo();
      setEmployeeInfo(res.data);
    } catch {}
  }, []);

  // Ref for polling interval (OAuth popup fallback) — must be before useEffects that reference them
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);

  const stopOAuthPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    popupRef.current = null;
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    loadOAuthStatus();
  }, [loadOAuthStatus]);

  // Load employee info when OAuth is configured
  useEffect(() => {
    if (oauthConfigured) {
      loadEmployeeInfo();
    }
  }, [oauthConfigured, loadEmployeeInfo]);

  // Listen for OAuth callback via postMessage (validate origin for security)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return; // Reject cross-origin messages
      if (event.data?.type === 'oauth-callback-success') {
        notifySuccess(t('settings.oauthSuccess'));
        dispatch(fetchConfig());
        loadOAuthStatus();
        loadEmployeeInfo();
        stopOAuthPolling(); // Stop polling if postMessage succeeded
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [dispatch, t, loadOAuthStatus, loadEmployeeInfo, stopOAuthPolling]);

  const handleSaveApp = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      notifyWarning(t('settings.enterBothOAuth'));
      return;
    }
    try {
      await api.saveOAuthApp(clientId.trim(), clientSecret.trim());
      notifySuccess(t('settings.oauthAppSaved'));
      setClientSecret('');
      loadOAuthStatus();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
    }
  };

  const startOAuthPolling = useCallback(() => {
    // Don't create duplicate intervals
    if (pollIntervalRef.current) return;

    // Track whether we've already seen OAuth configured (to detect change)
    let wasConfigured = false;
    // Get initial state
    api.getOAuthStatus().then(res => {
      wasConfigured = !!(res.data?.configured && res.data?.token_valid);
    }).catch(() => {});

    pollIntervalRef.current = setInterval(async () => {
      try {
        // Check if popup was closed by user
        if (popupRef.current && popupRef.current.closed) {
          // Popup closed — do one final check
          const res = await api.getOAuthStatus();
          if (res.data?.configured && res.data?.token_valid && !wasConfigured) {
            notifySuccess(t('settings.oauthSuccess'));
            dispatch(fetchConfig());
            loadOAuthStatus();
            loadEmployeeInfo();
          }
          stopOAuthPolling();
          return;
        }
        // Poll OAuth status endpoint — detect when configured + token_valid becomes true
        const res = await api.getOAuthStatus();
        if (res.data?.configured && res.data?.token_valid && !wasConfigured) {
          notifySuccess(t('settings.oauthSuccess'));
          dispatch(fetchConfig());
          loadOAuthStatus();
          loadEmployeeInfo();
          // Close popup if still open
          if (popupRef.current && !popupRef.current.closed) {
            popupRef.current.close();
          }
          stopOAuthPolling();
        }
      } catch {
        // Ignore polling errors
      }
    }, 2000);
  }, [dispatch, t, loadOAuthStatus, loadEmployeeInfo, stopOAuthPolling]);

  const handleAuthorize = async () => {
    try {
      const res = await api.getOAuthAuthorizeUrl();
      // Use named target + popup features to ensure window.opener is set
      const popup = window.open(
        res.data.url,
        'punchpilot_oauth',
        'popup=yes,width=600,height=700,left=200,top=100'
      );
      popupRef.current = popup;
      // Start polling as fallback (in case postMessage doesn't work)
      startOAuthPolling();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await api.verifyOAuth();
      if (res.data.valid) {
        notifySuccess(t('settings.verifySuccess'));
      } else {
        notifyError(res.data.error || t('settings.oauthVerifyFailed'));
      }
      loadOAuthStatus();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('settings.oauthVerifyFailed'));
    } finally {
      setVerifying(false);
    }
  };

  const handleClear = async () => {
    await api.clearOAuth();
    dispatch(fetchConfig());
    setOauthStatus(null);
    setEmployeeInfo(null);
    setClientId('');
    setClientSecret('');
    stopOAuthPolling();
    notifySuccess(t('settings.oauthClearedKeepWeb'));
  };

  const handleSelectCompany = async (companyId: string | number) => {
    try {
      await api.selectOAuthCompany(companyId);
      notifySuccess(t('settings.companySelected'));
      dispatch(fetchConfig());
      loadOAuthStatus();
    } catch (err: any) {
      notifyError(err?.response?.data?.error || t('common.error'));
    }
  };

  const currentStep = oauthConfigured ? 2 : clientId || oauthStatus?.app_configured ? 1 : 0;
  const companies = oauthStatus?.companies || [];
  const needsSelection = oauthStatus?.needs_company_selection;

  // Format token expiry time
  const formatTokenExpiry = () => {
    if (!oauthStatus?.token_expires_at) return '';
    const expiresAt = dayjs.unix(oauthStatus.token_expires_at);
    return expiresAt.format('YYYY-MM-DD HH:mm');
  };

  return (
    <Card>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* Header with status tag */}
        <Space align="center">
          <Title level={5} style={{ margin: 0 }}>
            {t('settings.oauthTitle')}
          </Title>
          {oauthConfigured ? (
            <Tag icon={<CheckCircleFilled />} color="success">
              {t('settings.oauthConnected')}
            </Tag>
          ) : (
            <Tag icon={<CloseCircleFilled />} color="error">
              {t('settings.notConfigured')}
            </Tag>
          )}
        </Space>

        {/* Steps indicator */}
        <Steps
          current={currentStep}
          size="small"
          items={[
            { title: t('settings.oauthStep1') },
            { title: t('settings.oauthStep2') },
            { title: t('settings.oauthStatus') },
          ]}
        />

        {/* Step 1: App credentials */}
        <div>
          <Title level={5} style={{ fontSize: 14 }}>
            {t('settings.oauthStep1')}
          </Title>
          <Form layout="vertical" size="middle">
            <Form.Item label={t('settings.clientId')}>
              <Input
                placeholder={t('settings.clientIdPlaceholder')}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </Form.Item>
            <Form.Item label={t('settings.clientSecret')}>
              <Input.Password
                placeholder={t('settings.clientSecretPlaceholder')}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </Form.Item>
          </Form>
          <Button type="primary" onClick={handleSaveApp}>
            {t('settings.saveOAuthApp')}
          </Button>
        </div>

        {/* Step 2: Authorize */}
        <div>
          <Title level={5} style={{ fontSize: 14 }}>
            {t('settings.oauthStep2')}
          </Title>
          <Button icon={<LinkOutlined />} onClick={handleAuthorize}>
            {t('settings.authorizeWithFreee')}
          </Button>
        </div>

        {/* Company selection (when multiple companies) */}
        {needsSelection && companies.length > 1 && (
          <Alert
            type="warning"
            showIcon
            message={t('settings.multiCompanyTitle')}
            description={
              <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
                <Text>{t('settings.multiCompanyHint')}</Text>
                <Select
                  placeholder={t('settings.selectCompany')}
                  style={{ width: '100%' }}
                  onChange={handleSelectCompany}
                  options={companies.map((c: any) => ({
                    label: `${c.name} (ID: ${c.id}, ${t('settings.oauthEmployeeId')}: ${c.employee_id})`,
                    value: c.id,
                  }))}
                />
              </Space>
            }
          />
        )}

        {/* OAuth Status panel */}
        <div>
          <Title level={5} style={{ fontSize: 14 }}>
            {t('settings.oauthStatus')}
          </Title>
          {oauthConfigured && oauthStatus ? (
            <Descriptions column={1} size="small" bordered>
              {/* Client ID (masked) */}
              {oauthStatus.client_id_masked && (
                <Descriptions.Item label={t('settings.clientId')}>
                  <Text copyable={false} code style={{ fontSize: 12 }}>{oauthStatus.client_id_masked}</Text>
                </Descriptions.Item>
              )}
              {/* Connection status */}
              <Descriptions.Item label={t('settings.oauthTokenExpiry')}>
                {oauthStatus.token_valid ? (
                  <Space>
                    <Tag color="success">{t('settings.oauthTokenValid')}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('settings.oauthTokenExpiresAt', { time: formatTokenExpiry() })}
                    </Text>
                  </Space>
                ) : (
                  <Tag color="warning">{t('settings.oauthTokenExpired')}</Tag>
                )}
              </Descriptions.Item>
              {/* Company: name + ID combined, with switch option for multi-company */}
              <Descriptions.Item label={t('settings.oauthCompany')}>
                {companies.length > 1 && oauthStatus.company_id ? (
                  <Select
                    size="small"
                    value={String(oauthStatus.company_id)}
                    style={{ width: 320 }}
                    onChange={handleSelectCompany}
                    options={companies.map((c: any) => ({
                      label: `${c.name} (ID: ${c.id})`,
                      value: String(c.id),
                    }))}
                  />
                ) : (
                  oauthStatus.company_name
                    ? `${oauthStatus.company_name} (ID: ${oauthStatus.company_id})`
                    : oauthStatus.company_id || '-'
                )}
              </Descriptions.Item>
              {/* User name */}
              {oauthStatus.user_display_name && (
                <Descriptions.Item label={t('settings.oauthUserName')}>
                  {oauthStatus.user_display_name}
                </Descriptions.Item>
              )}
              {/* Employee number */}
              {(oauthStatus.employee_num || employeeInfo?.num) && (
                <Descriptions.Item label={t('settings.oauthEmployeeNum')}>
                  {oauthStatus.employee_num || employeeInfo?.num}
                </Descriptions.Item>
              )}
              {/* Department (from employee info) */}
              {employeeInfo?.department && (
                <Descriptions.Item label={t('settings.oauthDepartment')}>
                  {employeeInfo.department}
                </Descriptions.Item>
              )}
              {/* Position (from employee info) */}
              {(employeeInfo?.position || employeeInfo?.title) && (
                <Descriptions.Item label={t('settings.oauthPosition')}>
                  {employeeInfo.position || employeeInfo.title}
                </Descriptions.Item>
              )}
              {/* Employment type (from employee info) */}
              {employeeInfo?.employment_type && (
                <Descriptions.Item label={t('settings.oauthEmploymentType')}>
                  {employeeInfo.employment_type}
                </Descriptions.Item>
              )}
              {/* Entry date (from employee info) */}
              {employeeInfo?.entry_date && (
                <Descriptions.Item label={t('settings.oauthEntryDate')}>
                  {employeeInfo.entry_date}
                </Descriptions.Item>
              )}
              {/* Employee ID */}
              <Descriptions.Item label={t('settings.oauthEmployeeId')}>
                {oauthStatus.employee_id || '-'}
              </Descriptions.Item>
              {/* User ID (freee user ID) */}
              {oauthStatus.user_id && (
                <Descriptions.Item label={t('settings.oauthUserId')}>
                  {oauthStatus.user_id}
                </Descriptions.Item>
              )}
            </Descriptions>
          ) : (
            <Alert type="info" showIcon message={t('settings.oauthNotConfigured')} />
          )}
        </div>

        {/* Action buttons */}
        <Space>
          <Button
            onClick={handleVerify}
            disabled={verifying || !oauthConfigured}
            loading={verifying}
          >
            {t('settings.verify')}
          </Button>
          {oauthConfigured && (
            <Button danger onClick={handleClear}>
              {t('settings.oauthClear')}
            </Button>
          )}
        </Space>

        {/* Encryption notice */}
        <Space size={4} align="center">
          <LockOutlined style={{ fontSize: 14, color: '#94a3b8' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('settings.oauthEncryption')}
          </Text>
        </Space>
      </Space>
    </Card>
  );
};

export default OAuthConfigCard;
