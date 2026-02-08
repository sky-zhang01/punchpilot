import React from 'react';
import { Link } from 'react-router-dom';

interface PunchPilotLogoProps {
  size?: number;
  collapsed?: boolean;
  showText?: boolean;
}

/**
 * PunchPilot logo: industrial punch-clock machine with gear, clock face,
 * stamp mechanism, and LED status panel. Matches the favicon design.
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
        viewBox="0 0 512 512"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <linearGradient id="pp-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1a3a5c" />
            <stop offset="100%" stopColor="#0d2137" />
          </linearGradient>
          <linearGradient id="pp-gear" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5ba3e6" />
            <stop offset="100%" stopColor="#2d7dd2" />
          </linearGradient>
          <linearGradient id="pp-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e8eef4" />
            <stop offset="100%" stopColor="#c5d3e0" />
          </linearGradient>
          <linearGradient id="pp-glow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4fc3f7" />
            <stop offset="100%" stopColor="#1e88e5" />
          </linearGradient>
        </defs>

        {/* Background rounded square */}
        <rect width="512" height="512" rx="96" fill="url(#pp-bg)" />

        {/* Circuit traces */}
        <g stroke="#2a5a8a" strokeWidth="1.5" fill="none" opacity="0.3">
          <path d="M80 400 h60 v-40 h30" />
          <path d="M120 420 v30 h50" />
          <path d="M350 400 h40 v-30 h30" />
          <path d="M380 430 v20 h40" />
          <circle cx="170" cy="360" r="3" fill="#2a5a8a" />
          <circle cx="420" cy="370" r="3" fill="#2a5a8a" />
          <circle cx="140" cy="450" r="3" fill="#2a5a8a" />
          <circle cx="390" cy="450" r="3" fill="#2a5a8a" />
        </g>

        {/* Machine body */}
        <rect x="130" y="140" width="252" height="280" rx="20" fill="url(#pp-body)" stroke="#a0b4c8" strokeWidth="2" />

        {/* Top bar */}
        <rect x="130" y="140" width="252" height="40" rx="20" fill="#c5d3e0" stroke="#a0b4c8" strokeWidth="2" />
        <rect x="130" y="160" width="252" height="20" fill="#c5d3e0" />

        {/* Gear */}
        <g transform="translate(256, 110)">
          <circle cx="0" cy="0" r="52" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="2" />
          <circle cx="0" cy="0" r="36" fill="none" stroke="#1e6cb8" strokeWidth="1.5" opacity="0.5" />
          <circle cx="0" cy="0" r="16" fill="#1a3a5c" stroke="#1e6cb8" strokeWidth="2" />
          <circle cx="0" cy="0" r="8" fill="#2d7dd2" />
          {/* Gear teeth */}
          <rect x="-8" y="-65" width="16" height="18" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" />
          <rect x="-8" y="47" width="16" height="18" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" />
          <rect x="-65" y="-8" width="18" height="16" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" />
          <rect x="47" y="-8" width="18" height="16" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" />
          <rect x="30" y="-52" width="16" height="18" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" transform="rotate(45 38 -43)" />
          <rect x="-46" y="-52" width="16" height="18" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" transform="rotate(-45 -38 -43)" />
          <rect x="30" y="34" width="16" height="18" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" transform="rotate(-45 38 43)" />
          <rect x="-46" y="34" width="16" height="18" rx="3" fill="url(#pp-gear)" stroke="#1e6cb8" strokeWidth="1.5" transform="rotate(45 -38 43)" />
        </g>

        {/* Stamp mechanism */}
        <line x1="256" y1="120" x2="256" y2="165" stroke="#7a94aa" strokeWidth="4" strokeLinecap="round" />
        <rect x="244" y="165" width="24" height="20" rx="4" fill="#8aa0b4" stroke="#7a94aa" strokeWidth="1.5" />
        <rect x="236" y="180" width="40" height="50" rx="6" fill="#a0b4c8" stroke="#7a94aa" strokeWidth="1.5" />

        {/* Clock face */}
        <circle cx="256" cy="270" r="72" fill="white" stroke="#5ba3e6" strokeWidth="3" />
        <circle cx="256" cy="270" r="65" fill="none" stroke="#d0dce8" strokeWidth="1" />

        {/* Major hour markers */}
        <g stroke="#2d5f8a" strokeWidth="3" strokeLinecap="round">
          <line x1="256" y1="205" x2="256" y2="215" />
          <line x1="321" y1="270" x2="311" y2="270" />
          <line x1="256" y1="335" x2="256" y2="325" />
          <line x1="191" y1="270" x2="201" y2="270" />
        </g>

        {/* Minor hour markers */}
        <g stroke="#8aa8c4" strokeWidth="2" strokeLinecap="round">
          <line x1="288" y1="210" x2="284" y2="219" />
          <line x1="314" y1="238" x2="305" y2="242" />
          <line x1="314" y1="302" x2="305" y2="298" />
          <line x1="288" y1="330" x2="284" y2="321" />
          <line x1="224" y1="330" x2="228" y2="321" />
          <line x1="198" y1="302" x2="207" y2="298" />
          <line x1="198" y1="238" x2="207" y2="242" />
          <line x1="224" y1="210" x2="228" y2="219" />
        </g>

        {/* Hour hand (9 o'clock) */}
        <line x1="256" y1="270" x2="213" y2="270" stroke="#1a3a5c" strokeWidth="5" strokeLinecap="round" />
        {/* Minute hand (12 o'clock) */}
        <line x1="256" y1="270" x2="256" y2="215" stroke="#2d7dd2" strokeWidth="3" strokeLinecap="round" />
        {/* Center dot */}
        <circle cx="256" cy="270" r="6" fill="#1a3a5c" />
        <circle cx="256" cy="270" r="3" fill="#5ba3e6" />

        {/* LED panel */}
        <rect x="170" y="360" width="172" height="40" rx="8" fill="#0a1a2a" stroke="#2d5f8a" strokeWidth="1.5" />
        <text x="218" y="387" fontFamily="monospace" fontSize="22" fill="url(#pp-glow)" fontWeight="bold" letterSpacing="2">09:00</text>

        {/* Check mark */}
        <circle cx="320" cy="380" r="12" fill="none" stroke="#4caf50" strokeWidth="2" />
        <polyline points="312,380 318,386 328,374" fill="none" stroke="#4caf50" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Glow accents */}
        <circle cx="160" cy="370" r="4" fill="#4fc3f7" opacity="0.6" />
        <circle cx="352" cy="370" r="4" fill="#4fc3f7" opacity="0.6" />
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
