import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import zh from './locales/zh';
import ja from './locales/ja';

// Detect browser language, default to English
function detectLocale(): string {
  const saved = localStorage.getItem('pp-locale');
  if (saved && ['en', 'zh', 'ja'].includes(saved)) return saved;

  const browserLang = navigator.language || 'en';
  if (browserLang.startsWith('zh')) return 'zh';
  if (browserLang.startsWith('ja')) return 'ja';
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
    ja: { translation: ja },
  },
  lng: detectLocale(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
