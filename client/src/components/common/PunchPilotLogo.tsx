import React from 'react';
import { Link } from 'react-router-dom';

interface PunchPilotLogoProps {
  size?: number;
  collapsed?: boolean;
  showText?: boolean;
}

/**
 * PunchPilot logo: a clean clock face with hands at 10:10 position.
 * Wrapped in a Link to /dashboard for clickable navigation.
 */
const PunchPilotLogo: React.FC<PunchPilotLogoProps> = ({
  size = 40,
  collapsed = false,
  showText = true,
}) => {
  return (
    <Link to="/dashboard" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        {/* Clock circle background */}
        <circle cx="60" cy="60" r="54" fill="#1677ff" opacity="0.12" />
        <circle cx="60" cy="60" r="54" stroke="#1677ff" strokeWidth="3.5" fill="none" />

        {/* Hour markers at 12, 3, 6, 9 o'clock */}
        <rect x="57" y="10" width="6" height="12" rx="3" fill="#1677ff" opacity="0.7" />
        <rect x="98" y="57" width="12" height="6" rx="3" fill="#1677ff" opacity="0.7" />
        <rect x="57" y="98" width="6" height="12" rx="3" fill="#1677ff" opacity="0.7" />
        <rect x="10" y="57" width="12" height="6" rx="3" fill="#1677ff" opacity="0.7" />

        {/* Minor hour markers */}
        <circle cx="81" cy="21" r="2.5" fill="#1677ff" opacity="0.35" />
        <circle cx="99" cy="39" r="2.5" fill="#1677ff" opacity="0.35" />
        <circle cx="99" cy="81" r="2.5" fill="#1677ff" opacity="0.35" />
        <circle cx="81" cy="99" r="2.5" fill="#1677ff" opacity="0.35" />
        <circle cx="39" cy="99" r="2.5" fill="#1677ff" opacity="0.35" />
        <circle cx="21" cy="81" r="2.5" fill="#1677ff" opacity="0.35" />
        <circle cx="21" cy="39" r="2.5" fill="#1677ff" opacity="0.35" />
        <circle cx="39" cy="21" r="2.5" fill="#1677ff" opacity="0.35" />

        {/* Hour hand pointing to ~10 o'clock */}
        <line x1="60" y1="60" x2="39" y2="48" stroke="#1677ff" strokeWidth="5" strokeLinecap="round" />

        {/* Minute hand pointing to ~2 o'clock */}
        <line x1="60" y1="60" x2="88" y2="44" stroke="#1677ff" strokeWidth="3.5" strokeLinecap="round" />

        {/* Center dot */}
        <circle cx="60" cy="60" r="5" fill="#1677ff" />
        <circle cx="60" cy="60" r="2" fill="#fff" />
      </svg>

      {showText && !collapsed && (
        <span
          style={{
            fontSize: size * 0.45,
            fontWeight: 700,
            color: 'var(--pp-text-primary, #333)',
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
          }}
        >
          PunchPilot
        </span>
      )}
    </Link>
  );
};

export default PunchPilotLogo;
