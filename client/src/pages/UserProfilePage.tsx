import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  Card,
  Form,
  Input,
  Button,
  Typography,
  Alert,
  Descriptions,
} from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { changePassword } from '../store/authSlice';
import PasswordStrengthMeter, {
  passwordRules,
} from '../components/common/PasswordStrengthMeter';
import { notifySuccess, notifyError } from '../utils/notify';

const { Title, Text } = Typography;

const UserProfilePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { username } = useAppSelector((state) => state.auth);

  const [form] = Form.useForm();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const handleSubmit = async (values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    setError('');

    // Validate password strength
    const requiredRules = passwordRules.filter((r) => r.required);
    if (!requiredRules.every((r) => r.test(values.newPassword))) {
      setError(t('profile.error.passwordWeak'));
      return;
    }

    // Validate passwords match
    if (values.newPassword !== values.confirmPassword) {
      setError(t('profile.error.mismatch'));
      return;
    }

    setSaving(true);
    try {
      await dispatch(
        changePassword({
          current_password: values.currentPassword,
          new_password: values.newPassword,
        })
      ).unwrap();
      notifySuccess(t('profile.success'));
      // Redirect to login after password change
      setTimeout(() => navigate('/login'), 2000);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || t('profile.error.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 520 }}>
      {/* User info card */}
      <Card style={{ marginBottom: 24 }}>
        <Title level={5} style={{ marginTop: 0 }}>
          <UserOutlined style={{ marginRight: 8 }} />
          {t('profile.title')}
        </Title>
        <Descriptions column={1} size="small">
          <Descriptions.Item label={t('profile.currentUsername')}>
            <Text strong>{username}</Text>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* Change password card */}
      <Card>
        <Title level={5} style={{ marginTop: 0 }}>
          <LockOutlined style={{ marginRight: 8 }} />
          {t('profile.changePassword')}
        </Title>

        {error && (
          <Alert
            type="error"
            message={error}
            closable
            onClose={() => setError('')}
            style={{ marginBottom: 16 }}
          />
        )}

        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          autoComplete="off"
        >
          <Form.Item
            name="currentPassword"
            label={t('profile.currentPassword')}
            rules={[
              {
                required: true,
                message: t('profile.error.enterCurrent'),
              },
            ]}
          >
            <Input.Password
              placeholder={t('profile.currentPasswordPlaceholder')}
              prefix={<LockOutlined />}
            />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label={t('profile.newPassword')}
            rules={[
              {
                required: true,
                message: t('profile.error.passwordWeak'),
              },
            ]}
          >
            <Input.Password
              placeholder={t('profile.newPasswordPlaceholder')}
              prefix={<LockOutlined />}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Form.Item>

          {/* Password strength meter rendered below the new password field */}
          <div style={{ marginTop: -12, marginBottom: 16 }}>
            <PasswordStrengthMeter password={newPassword} />
          </div>

          <Form.Item
            name="confirmPassword"
            label={t('profile.confirmPassword')}
            dependencies={['newPassword']}
            rules={[
              {
                required: true,
                message: t('profile.error.mismatch'),
              },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(
                    new Error(t('profile.error.mismatch'))
                  );
                },
              }),
            ]}
          >
            <Input.Password
              placeholder={t('profile.confirmPasswordPlaceholder')}
              prefix={<LockOutlined />}
            />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t('profile.save')}
            </Button>
          </Form.Item>
        </Form>

      </Card>
    </div>
  );
};

export default UserProfilePage;
