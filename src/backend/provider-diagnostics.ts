import { ProviderError } from './providers/types';

/** 检测样例要与用户选定的原文语言一致，不能把英语句子标成日语而误报成功。 */
const SAMPLES: Record<string, string> = {
  en: 'This browser translates complete English sentences locally, including common words and clear sentence structure.',
  zh: '这个浏览器能够在本地翻译完整的句子，让我们用一段清楚的文字检查翻译服务。',
  'zh-Hant': '這個瀏覽器能夠在本機翻譯完整的句子，讓我們用一段清楚的文字檢查翻譯服務。',
  ja: 'このブラウザーは文章を翻訳できます。自然な文章を使って翻訳サービスが動作するか確認します。',
  ko: '이 브라우저는 문장을 번역할 수 있습니다. 자연스러운 문장으로 번역 서비스가 작동하는지 확인합니다.',
  fr: 'Ce navigateur peut traduire des phrases complètes. Nous vérifions le service avec un texte simple et naturel.',
  de: 'Dieser Browser kann vollständige Sätze übersetzen. Wir prüfen den Übersetzungsdienst mit einem einfachen Text.',
  es: 'Este navegador puede traducir frases completas. Comprobamos el servicio con un texto sencillo y natural.',
  pt: 'Este navegador pode traduzir frases completas. Verificamos o serviço com um texto simples e natural.',
  it: 'Questo browser può tradurre frasi complete. Verifichiamo il servizio con un testo semplice e naturale.',
  ru: 'Этот браузер умеет переводить полные предложения. Проверим работу службы перевода на простом тексте.',
  sv: 'Den här webbläsaren kan översätta hela meningar. Vi testar översättningstjänsten med en enkel och naturlig text.',
  nl: 'Deze browser kan volledige zinnen vertalen. We controleren de vertaaldienst met een eenvoudige tekst.',
  pl: 'Ta przeglądarka może tłumaczyć całe zdania. Sprawdzamy usługę tłumaczenia za pomocą prostego tekstu.',
  tr: 'Bu tarayıcı tam cümleleri çevirebilir. Çeviri hizmetini basit ve doğal bir metinle kontrol ediyoruz.',
  uk: 'Цей браузер може перекладати цілі речення. Перевіримо службу перекладу за допомогою простого тексту.',
  vi: 'Trình duyệt này có thể dịch các câu hoàn chỉnh. Chúng tôi kiểm tra dịch vụ dịch bằng một đoạn văn đơn giản.',
  th: 'เบราว์เซอร์นี้สามารถแปลประโยคที่สมบูรณ์ได้ เรากำลังตรวจสอบบริการแปลด้วยข้อความที่เรียบง่าย',
  id: 'Peramban ini dapat menerjemahkan kalimat lengkap. Kami memeriksa layanan terjemahan dengan teks sederhana.',
  ar: 'يمكن لهذا المتصفح ترجمة جمل كاملة. نتحقق من خدمة الترجمة باستخدام نص بسيط وواضح.',
};

export function diagnosticPair(sourceLang = 'auto', targetLang = 'zh-CN') {
  // 自动检测没有固定原文语言；目标英语时改用中文样例，避免英语原样回传造成假成功。
  const sampleLang = sourceLang === 'auto' ? (/^en(?:-|$)/i.test(targetLang) ? 'zh-CN' : 'en') : sourceLang;
  return { sourceLang, targetLang, sampleLang };
}

export function diagnosticSample(sourceLang: string, targetLang = 'zh-CN'): string {
  const language = diagnosticPair(sourceLang, targetLang).sampleLang;
  let canonical: string;
  try { canonical = Intl.getCanonicalLocales(language)[0]!; }
  catch { throw new ProviderError({ code: 'bad_input', message: '检测原文语言代码无效', retryable: false }); }
  const code = /^zh-(?:Hant|TW|HK|MO)(?:-|$)/i.test(canonical) ? 'zh-Hant' : canonical.split('-')[0]!;
  const sample = SAMPLES[code];
  if (!sample) throw new ProviderError({ code: 'bad_input', message: `尚未提供 ${language} 的检测样例，请选择支持检测的原文语言`, retryable: false });
  return sample;
}
