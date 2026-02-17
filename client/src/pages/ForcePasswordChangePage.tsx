import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Form, Input, Button, Typography, Alert } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { useAppDispatch } from '../store/hooks';
import { changePassword } from '../store/authSlice';
import PunchPilotLogo from '../components/common/PunchPilotLogo';
import PasswordStrengthMeter, { passwordRules } from '../components/common/PasswordStrengthMeter';

const { Title, Text } = Typography;

const ForcePasswordChangePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const handleSubmit = async (values: {
    newUsername: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    setError('');

    // Additional password strength validation beyond form rules
    const requiredRules = passwordRules.filter((r) => r.required);
    const allMet = requiredRules.every((r) => r.test(values.newPassword));
    if (!allMet) {
      setError(t('changePassword.error.passwordWeak'));
      return;
    }

    setSaving(true);
    try {
      await dispatch(
        changePassword({
          new_username: values.newUsername.trim(),
          new_password: values.newPassword,
        })
      ).unwrap();
      navigate('/dashboard');
    } catch (err: any) {
      setError(err?.response?.data?.error || t('changePassword.error.failed'));
    } finally {
      setSaving(false);
    }
  };

  // Determine if dark mode is active for card background
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'linear-gradient(135deg, #f0f2f5 0%, #e6f7ff 100%)',
      }}
    >
      {/* Glassmorphism card */}
      <div
        style={{
          maxWidth: 440,
          width: '100%',
          margin: '0 16px',
          borderRadius: 16,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          backgroundColor: isDark
            ? 'rgba(30, 41, 59, 0.85)'
            : 'rgba(255, 255, 255, 0.85)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.08)',
          padding: 32,
        }}
      >
        {/* Logo and title */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <PunchPilotLogo size={48} showText={false} />
          </div>
          <Title
            level={4}
            style={{
              fontWeight: 700,
              color: 'var(--pp-text, #1e293b)',
              marginBottom: 4,
            }}
          >
            {t('changePassword.title')}
          </Title>
          <Text style={{ color: 'var(--pp-text-secondary, #64748b)' }}>
            {t('changePassword.subtitle')}
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

        {/* Password change form */}
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          autoComplete="off"
          requiredMark={false}
        >
          <Form.Item
            name="newUsername"
            label={t('changePassword.newUsername')}
            extra={t('changePassword.usernameHint')}
            rules={[
              {
                required: true,
                message: t('changePassword.error.usernameMin'),
              },
              {
                min: 2,
                message: t('changePassword.error.usernameMin'),
              },
              {
                validator: (_, value) => {
                  if (value && value.trim().toLowerCase() === 'admin') {
                    return Promise.reject(
                      new Error(t('changePassword.error.usernameAdmin'))
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input
              size="large"
              placeholder={t('changePassword.usernamePlaceholder')}
              style={{
                border: '1px solid #d9d9d9',
                borderRadius: 8,
              }}
            />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label={t('changePassword.newPassword')}
            rules={[
              {
                required: true,
                message: t('changePassword.error.passwordWeak'),
              },
            ]}
          >
            <Input.Password
              size="large"
              placeholder={t('changePassword.newPasswordPlaceholder')}
              onChange={(e) => setNewPassword(e.target.value)}
              style={{
                border: '1px solid #d9d9d9',
                borderRadius: 8,
              }}
            />
          </Form.Item>

          {/* Password strength meter placed between password and confirm */}
          <PasswordStrengthMeter password={newPassword} />

          <Form.Item
            name="confirmPassword"
            label={t('changePassword.confirmPassword')}
            dependencies={['newPassword']}
            style={{ marginTop: 16 }}
            rules={[
              {
                required: true,
                message: t('changePassword.error.mismatch'),
              },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(
                    new Error(t('changePassword.error.mismatch'))
                  );
                },
              }),
            ]}
          >
            <Input.Password
              size="large"
              placeholder={t('changePassword.confirmPasswordPlaceholder')}
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
              disabled={saving}
              style={{
                height: 48,
                backgroundColor: 'var(--pp-primary, #3b82f6)',
                borderColor: 'var(--pp-primary, #3b82f6)',
                borderRadius: 8,
              }}
            >
              {saving ? <LoadingOutlined spin /> : t('changePassword.save')}
            </Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  );
};

export default ForcePasswordChangePage;
