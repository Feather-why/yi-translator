import { setUiLang } from '../../frontend/i18n';
import { loadUiSettings } from '../../shared/settings';

// 先定界面语言，再加载阅读器
void loadUiSettings()
  .then((s) => setUiLang(s.uiLang), () => {})
  .then(() => import('../../frontend/pdf/reader'))
  .then(({ mountPdfReader }) => mountPdfReader(document.getElementById('app')!));
