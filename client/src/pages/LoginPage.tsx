import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Form, Input, Button, Typography, Alert, Dropdown, Space } from 'antd';
import { GlobalOutlined, LoadingOutlined, WarningOutlined } from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { loginUser } from '../store/authSlice';
import PunchPilotLogo from '../components/common/PunchPilotLogo';

const { Title, Text } = Typography;

const SHOW_RESET_HINT_AFTER = 3;

const LoginPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { loading } = useAppSelector((state) => state.auth);

  const [error, setError] = useState('');
  const [failCount, setFailCount] = useState(0);
  const [form] = Form.useForm();

  const handleSubmit = async (values: { username: string; password: string }) => {
    setError('');
    try {
      const result = await dispatch(
        loginUser({ username: values.username.trim(), password: values.password })
      ).unwrap();
      setFailCount(0);
      if (result.must_change_password) {
        navigate('/change-password');
      } else {
        navigate('/dashboard');
      }
    } catch (err: any) {
      setFailCount((prev) => prev + 1);
      setError(err?.response?.data?.error || t('login.failed'));
    }
  };

  const changeLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem('pp-locale', lang);
  };

  // Language dropdown menu items
  const languageItems = [
    { key: 'en', label: 'English', onClick: () => changeLanguage('en') },
    { key: 'zh', label: '\u4E2D\u6587', onClick: () => changeLanguage('zh') },
    { key: 'ja', label: '\u65E5\u672C\u8A9E', onClick: () => changeLanguage('ja') },
  ];

  // Determine if dark mode is active for card background
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #f0f2f5 0%, #e6f7ff 100%)',
        position: 'relative',
      }}
    >
      {/* Language selector - top right corner */}
      <div style={{ position: 'absolute', top: 16, right: 16 }}>
        <Dropdown menu={{ items: languageItems }} placement="bottomRight">
          <Button type="text" icon={<GlobalOutlined />} size="middle" />
        </Dropdown>
      </div>

      {/* Glassmorphism login card */}
      <div
        style={{
          maxWidth: 400,
          width: '100%',
          margin: '0 16px',
          borderRadius: 16,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          backgroundColor: isDark ? 'rgba(30, 41, 59, 0.85)' : 'rgba(255, 255, 255, 0.85)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.08)',
          padding: 32,
        }}
      >
        {/* Logo and title */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <PunchPilotLogo size={56} showText={false} />
          </div>
          <Title
            level={3}
            style={{
              fontWeight: 700,
              color: 'var(--pp-text, #1e293b)',
              marginBottom: 4,
            }}
          >
            {t('login.title')}
          </Title>
          <Text style={{ color: 'var(--pp-text-secondary, #64748b)' }}>
            {t('login.subtitle')}
          </Text>
        </div>

        {/* Error alert */}
        {error && (
          <Alert
            type="error"
            message={error}
            closable
            onClose={() => setError('')}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* Factory reset hint after repeated failures */}
        {failCount >= SHOW_RESET_HINT_AFTER && (
          <Alert
            type="warning"
            icon={<WarningOutlined />}
            showIcon
            message={t('login.resetHint')}
            description={
              <>
                <code
                  style={{
                    display: 'block',
                    marginTop: 4,
                    fontSize: 12,
                    backgroundColor: 'rgba(0,0,0,0.06)',
                    padding: '6px 10px',
                    borderRadius: 4,
                    wordBreak: 'break-all',
                  }}
                >
                  {t('login.resetCommand')}
                </code>
                <Text
                  type="secondary"
                  style={{ display: 'block', marginTop: 6, fontSize: 11 }}
                >
                  {t('login.resetWarning')}
                </Text>
              </>
            }
            style={{ marginBottom: 16 }}
          />
        )}

        {/* Login form */}
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          autoComplete="off"
          requiredMark={false}
        >
          <Form.Item
            name="username"
            label={t('login.username')}
            rules={[
              {
                required: true,
                message: t('login.enterUsername'),
                whitespace: true,
              },
            ]}
          >
            <Input
              size="large"
              autoFocus
              style={{
                border: '1px solid #d9d9d9',
                borderRadius: 8,
              }}
            />
          </Form.Item>

          <Form.Item
            name="password"
            label={t('login.password')}
            rules={[
              {
                required: true,
                message: t('login.enterPassword'),
              },
            ]}
          >
            <Input.Password
              size="large"
              style={{
                border: '1px solid #d9d9d9',
                borderRadius: 8,
              }}
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              size="large"
              block
              disabled={loading}
              style={{
                height: 48,
                fontSize: '1rem',
                backgroundColor: 'var(--pp-primary, #3b82f6)',
                borderColor: 'var(--pp-primary, #3b82f6)',
                borderRadius: 8,
              }}
            >
              {loading ? <LoadingOutlined spin /> : t('login.signIn')}
            </Button>
          </Form.Item>
        </Form>

        {/* Version text */}
        <Text
          style={{
            display: 'block',
            textAlign: 'center',
            marginTop: 24,
            color: 'var(--pp-text-muted, #94a3b8)',
            fontSize: 12,
          }}
        >
          PunchPilot v0.3.0
        </Text>
      </div>
    </div>
  );
};

export default LoginPage;
