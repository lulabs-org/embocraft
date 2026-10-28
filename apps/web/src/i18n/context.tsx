import { useCallback, type ReactNode } from 'react';
import { useTranslation as useReactI18nextTranslation } from 'react-i18next';
import './config';
import type { I18nContextType, Language } from './types';

export function I18nProvider({ children }: { children: ReactNode }) {
  // react-i18next manages its own state globally through i18next instance
  return <>{children}</>;
}

export function useI18n(): I18nContextType {
  const { t, i18n } = useReactI18nextTranslation();
  const currentLang = i18n.language?.startsWith('en') ? 'en' : 'zh';

  const setLanguage = useCallback(
    (lang: Language) => {
      void i18n.changeLanguage(lang);
    },
    [i18n],
  );

  const toggleLanguage = useCallback(() => {
    const nextLang = currentLang === 'zh' ? 'en' : 'zh';
    void i18n.changeLanguage(nextLang);
  }, [currentLang, i18n]);

  const translate = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      return t(key, params);
    },
    [t],
  );

  return {
    language: currentLang,
    setLanguage,
    toggleLanguage,
    t: translate,
  };
}
