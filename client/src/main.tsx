import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router';
import { ConfigProvider, App as AntdApp, theme as antdTheme } from 'antd';
import type { Locale } from 'antd/es/locale';
import enUS from 'antd/es/locale/en_US';
import zhCN from 'antd/es/locale/zh_CN';
import jaJP from 'antd/es/locale/ja_JP';
import { store } from './store';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import AppRouter from './router';
import i18n from './i18n';
import './assets/styles.css';

// dayjs locale setup
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/ja';
import updateLocale from 'dayjs/plugin/updateLocale';
dayjs.extend(updateLocale);
// Force Sunday as first day of week for all locales
dayjs.updateLocale('en', { weekStart: 0 });
dayjs.updateLocale('zh-cn', { weekStart: 0 });
dayjs.updateLocale('ja', { weekStart: 0 });

const savedLocale = localStorage.getItem('pp-locale') || 'en';
const dayjsLocaleMap: Record<string, string> = { en: 'en', zh: 'zh-cn', ja: 'ja' };
dayjs.locale(dayjsLocaleMap[savedLocale] || 'en');

// Map i18n language to antd locale object
const ANTD_LOCALE_MAP: Record<string, Locale> = {
  en: enUS,
  zh: zhCN,
  ja: jaJP,
};

/**
 * Inner app component that bridges ThemeContext to antd ConfigProvider.
 */
const AppWithTheme: React.FC = () => {
  const { isDark } = useTheme();
  const [antdLocale, setAntdLocale] = useState<Locale>(ANTD_LOCALE_MAP[i18n.language] || enUS);

  useEffect(() => {
    const handleLangChange = (lng: string) => {
      setAntdLocale(ANTD_LOCALE_MAP[lng] || enUS);
      dayjs.locale(dayjsLocaleMap[lng] || 'en');
    };
    i18n.on('languageChanged', handleLangChange);
    return () => { i18n.off('languageChanged', handleLangChange); };
  }, []);

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 8,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", "Noto Sans JP", sans-serif',
        },
      }}
    >
      <AntdApp>
        <AppRouter />
      </AntdApp>
    </ConfigProvider>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <ThemeProvider>
          <AppWithTheme />
        </ThemeProvider>
      </BrowserRouter>
    </Provider>
  </React.StrictMode>
);
