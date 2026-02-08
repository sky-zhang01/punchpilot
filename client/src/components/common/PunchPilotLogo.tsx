import React from 'react';
import { Link } from 'react-router-dom';

interface PunchPilotLogoProps {
  size?: number;
  collapsed?: boolean;
  showText?: boolean;
}

/**
 * PunchPilot logo: uses the brand PNG icon (time stamping machine).
 * Wrapped in a Link to /dashboard for clickable navigation.
 */
const PunchPilotLogo: React.FC<PunchPilotLogoProps> = ({
  size = 40,
  collapsed = false,
  showText = true,
}) => {
  return (
    <Link to="/dashboard" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
      <img
        src="/logo-256.png"
        alt="PunchPilot"
        width={size}
        height={size}
        style={{ flexShrink: 0, borderRadius: size * 0.18 }}
      />

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
