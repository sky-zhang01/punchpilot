import React, { useMemo } from 'react';
import { Progress, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

interface PasswordStrengthMeterProps {
  password: string;
}

interface Rule {
  key: string;
  test: (pw: string) => boolean;
  required: boolean;
}

// Password validation rules exported for external use
const rules: Rule[] = [
  { key: 'minLength', test: (pw) => pw.length >= 8, required: true },
  { key: 'uppercase', test: (pw) => /[A-Z]/.test(pw), required: true },
  { key: 'lowercase', test: (pw) => /[a-z]/.test(pw), required: true },
  { key: 'number', test: (pw) => /[0-9]/.test(pw), required: true },
  { key: 'special', test: (pw) => /[^A-Za-z0-9]/.test(pw), required: false },
];

const PasswordStrengthMeter: React.FC<PasswordStrengthMeterProps> = ({ password }) => {
  const { t } = useTranslation();

  const { score, label, color } = useMemo(() => {
    if (!password) {
      return { score: 0, label: '', color: 'inherit' };
    }

    let s = 0;
    for (const rule of rules) {
      if (rule.test(password)) {
        s += 20;
      }
    }

    let lbl: string;
    let clr: string;
    if (s <= 20) {
      lbl = t('passwordStrength.weak');
      clr = '#ef4444';
    } else if (s <= 40) {
      lbl = t('passwordStrength.fair');
      clr = '#f59e0b';
    } else if (s <= 80) {
      lbl = t('passwordStrength.good');
      clr = '#3b82f6';
    } else {
      lbl = t('passwordStrength.strong');
      clr = '#10b981';
    }

    return { score: s, label: lbl, color: clr };
  }, [password, t]);

  return (
    <div style={{ marginTop: 4 }}>
      {password && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <Progress
            percent={score}
            showInfo={false}
            strokeColor={color}
            trailColor="var(--pp-border, #e2e8f0)"
            size={['100%', 6]}
            style={{ flex: 1 }}
          />
          <Text
            style={{
              color,
              fontWeight: 600,
              fontSize: 12,
              minWidth: 40,
            }}
          >
            {label}
          </Text>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
        {rules.map((rule) => {
          const passed = password ? rule.test(password) : false;
          return (
            <div
              key={rule.key}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              {passed ? (
                <CheckCircleFilled style={{ fontSize: 14, color: '#10b981' }} />
              ) : (
                <CloseCircleFilled
                  style={{
                    fontSize: 14,
                    color: rule.required ? '#ef4444' : '#94a3b8',
                  }}
                />
              )}
              <Text
                type={passed ? 'success' : undefined}
                style={{
                  fontSize: 12,
                  color: passed
                    ? undefined
                    : 'var(--pp-text-secondary, #64748b)',
                }}
              >
                {t(`passwordStrength.${rule.key}`)}
              </Text>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PasswordStrengthMeter;

export { rules as passwordRules };
