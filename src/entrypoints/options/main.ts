import { setUiLang } from '../../frontend/i18n';
import { loadUiSettings } from '../../shared/settings';

// 先定界面语言，再加载设置页（各页面模块顶层的文字表按这个语言生成）
void loadUiSettings()
  .then((s) => setUiLang(s.uiLang), () => {})
  .then(() => import('../../frontend/options/app'))
  .then(({ mountOptions }) => mountOptions(document.getElementById('app')!));
