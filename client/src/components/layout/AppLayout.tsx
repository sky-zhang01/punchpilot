import React, { useState, useEffect, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Layout,
  Button,
  Switch,
  Dropdown,
  Tag,
  Typography,
  Space,
  FloatButton,
  Tooltip,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  DashboardOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  CalendarOutlined,
  UserOutlined,
  ExportOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { useTheme } from '../../theme/ThemeContext';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { logoutUser } from '../../store/authSlice';
import { fetchConfig } from '../../store/configSlice';
import PunchPilotLogo from '../common/PunchPilotLogo';

const { Header, Sider, Content, Footer } = Layout;
const { Text } = Typography;

// Flag emoji + label for language display
const LANG_FLAGS: Record<string, string> = {
  en: '\u{1F1FA}\u{1F1F8}',
  zh: '\u{1F1E8}\u{1F1F3}',
  ja: '\u{1F1EF}\u{1F1F5}',
};

const LANG_LABELS: Record<string, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
};

interface NavItem {
  path: string;
  labelKey: string;
  icon: React.ReactNode;
}

// Navigation items — Profile removed (accessible via header username click)
const navItems: NavItem[] = [
  { path: '/dashboard', labelKey: 'nav.dashboard', icon: <DashboardOutlined /> },
  { path: '/calendar', labelKey: 'nav.calendar', icon: <CalendarOutlined /> },
  { path: '/logs', labelKey: 'nav.logs', icon: <UnorderedListOutlined /> },
  { path: '/settings', labelKey: 'nav.settings', icon: <SettingOutlined /> },
];

// Max width for content area
const CONTENT_MAX_WIDTH = 960;

const AppLayout: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const { isDark, setTheme } = useTheme();
  const contentRef = useRef<HTMLDivElement>(null);

  const [collapsed, setCollapsed] = useState(false);

  const { debugMode } = useAppSelector((state) => state.config);
  const { username } = useAppSelector((state) => state.auth);

  // Fetch config on mount
  useEffect(() => {
    dispatch(fetchConfig());
  }, [dispatch]);

  const handleLogout = async () => {
    await dispatch(logoutUser());
    navigate('/login');
  };

  const changeLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem('pp-locale', lang);
  };

  const handleThemeToggle = (checked: boolean) => {
    setTheme(checked ? 'dark' : 'light');
  };

  const currentLang = i18n.language || 'en';

  // Current page title — include Profile page which is not in sidebar
  const currentNav = navItems.find((item) => location.pathname.startsWith(item.path));
  const pageTitle = currentNav
    ? t(currentNav.labelKey)
    : location.pathname.startsWith('/profile')
      ? t('nav.profile')
      : '';

  const selectedKey = navItems.find((item) => location.pathname.startsWith(item.path))?.path || '';

  const languageMenuItems: MenuProps['items'] = [
    { key: 'en', label: `${LANG_FLAGS.en} English`, onClick: () => changeLanguage('en') },
    { key: 'zh', label: `${LANG_FLAGS.zh} 中文`, onClick: () => changeLanguage('zh') },
    { key: 'ja', label: `${LANG_FLAGS.ja} 日本語`, onClick: () => changeLanguage('ja') },
  ];

  // Google-style sidebar colors
  const sidebarBg = isDark ? '#1f1f1f' : '#f6f8fc';
  const sidebarBorder = isDark ? '#333' : '#e3e7ed';
  const itemHoverBg = isDark ? '#2a2a2a' : '#e8eaed';
  const itemActiveBg = isDark ? '#263d5c' : '#d3e3fd';
  const itemActiveText = isDark ? '#8ab4f8' : '#1a73e8';
  const itemDefaultText = isDark ? '#c4c7c5' : '#444746';
  const collapseIconColor = isDark ? '#999' : '#5f6368';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* Google-style Sidebar */}
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        breakpoint="lg"
        collapsedWidth={68}
        width={240}
        style={{
          overflow: 'auto',
          height: '100vh',
          position: 'sticky',
          top: 0,
          left: 0,
          background: sidebarBg,
          borderRight: `1px solid ${sidebarBorder}`,
        }}
        theme="light"
      >
        {/* Logo area — freee style: logo + hamburger always in same row */}
        <div
          style={{
            padding: collapsed ? '12px 8px' : '12px 16px',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: collapsed ? 'space-evenly' : 'space-between',
            gap: 4,
            minHeight: 56,
          }}
        >
          <PunchPilotLogo size={collapsed ? 28 : 32} collapsed={collapsed} showText={!collapsed} />
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            size="small"
            style={{ color: collapseIconColor, flexShrink: 0 }}
          />
        </div>

        {/* Google-style navigation items */}
        <nav style={{ padding: collapsed ? '8px 4px' : '8px 12px' }}>
          {navItems.map((item) => {
            const isActive = location.pathname.startsWith(item.path);
            return (
              <div
                key={item.path}
                onClick={() => navigate(item.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: collapsed ? 0 : 12,
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  padding: collapsed ? '10px 0' : '10px 16px',
                  marginBottom: 2,
                  borderRadius: 24,
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                  backgroundColor: isActive ? itemActiveBg : 'transparent',
                  color: isActive ? itemActiveText : itemDefaultText,
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 14,
                  position: 'relative',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = itemHoverBg;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0, width: collapsed ? 'auto' : 20, textAlign: 'center' }}>
                  {item.icon}
                </span>
                {!collapsed && (
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t(item.labelKey)}
                  </span>
                )}
              </div>
            );
          })}
        </nav>

        {/* Bottom area: debug tag — pinned at sidebar bottom */}
        {debugMode && (
          <div
            style={{
              position: 'sticky',
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              padding: '8px 0 12px',
              background: sidebarBg,
            }}
          >
            <Tag color="warning" style={{ fontSize: 11, margin: 0 }}>
              {collapsed ? 'M' : t('header.mockMode')}
            </Tag>
          </div>
        )}
      </Sider>

      {/* Main content area */}
      <Layout>
        {/* Top header bar */}
        <Header
          style={{
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: isDark ? '#141414' : '#fff',
            borderBottom: `1px solid ${isDark ? '#333' : '#e8e8e8'}`,
            position: 'sticky',
            top: 0,
            zIndex: 10,
            height: 56,
            lineHeight: '56px',
          }}
        >
          {/* Left: page title */}
          <Text strong style={{ fontSize: 18 }}>
            {pageTitle}
          </Text>

          {/* Right side controls */}
          <Space size="middle" align="center">
            {/* Dark mode toggle */}
            <Space size={6} align="center">
              <Text type="secondary" style={{ fontSize: 12 }}>
                {isDark ? t('header.darkMode') : t('header.lightMode')}
              </Text>
              <Switch
                checked={isDark}
                onChange={handleThemeToggle}
                size="small"
              />
            </Space>

            {/* Language dropdown: flag + language name */}
            <Dropdown menu={{ items: languageMenuItems }} placement="bottomRight">
              <Button type="text" size="small" style={{ padding: '0 8px', fontSize: 13 }}>
                <span style={{ fontSize: 16, marginRight: 4 }}>{LANG_FLAGS[currentLang] || LANG_FLAGS.en}</span>
                {LANG_LABELS[currentLang] || LANG_LABELS.en}
              </Button>
            </Dropdown>

            {/* Username — click to go to profile */}
            <Text
              type="secondary"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate('/profile')}
            >
              <UserOutlined style={{ marginRight: 4 }} />
              {username}
            </Text>

            {/* Logout */}
            <Tooltip title={t('header.logout')}>
              <Button
                type="text"
                danger
                icon={<ExportOutlined />}
                onClick={handleLogout}
                size="small"
              />
            </Tooltip>
          </Space>
        </Header>

        {/* Content */}
        <Content
          ref={contentRef}
          style={{
            padding: 24,
            overflow: 'auto',
            flex: 1,
          }}
        >
          <div style={{ maxWidth: CONTENT_MAX_WIDTH, margin: '0 auto', width: '100%' }}>
            <Outlet />
          </div>
        </Content>

        {/* Footer */}
        <Footer style={{ textAlign: 'center', padding: '12px 24px' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            PunchPilot v{__APP_VERSION__} | Developed by Sky Zhang
          </Text>
        </Footer>
      </Layout>

      <FloatButton.BackTop
        target={() => {
          // The Content div has overflow:auto, so it's the scroll container.
          // If that doesn't work (e.g. window scrolls instead), fall back to window.
          const el = contentRef.current;
          if (el && el.scrollHeight > el.clientHeight) return el;
          return window;
        }}
        visibilityHeight={200}
      />
    </Layout>
  );
};

export default AppLayout;
