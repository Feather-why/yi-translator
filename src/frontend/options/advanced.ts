/**
 * 「高级」页：后端已经实现、之前没有界面的功能。
 *   站点规则：本地规则（新建 / 编辑 / 删除）、规则订阅（订阅 / 刷新 / 回滚）
 *   同步与备份：WebDAV 同步（默认不含密钥）、密钥加密备份与恢复
 *   词典与词对齐：导入 ECDICT 词典、词对齐模型（本机 / 远程节点）
 */
import type { BackendCapabilities, RuleSubscriptionInfo } from '../../shared/backend-v2';
import type { SiteRule } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import { loadCoreSettings } from '../../shared/settings';
import { h } from '../ui/host';
import { clearRuleCache } from '../content/rule-cache';
import { L } from '../i18n';

const SUBS_KEY = 'ui.ruleSubscriptions';

interface SubRow {
  url: string;
  version?: RuleSubscriptionInfo['version'];
  updatedAt?: number;
  lastError?: string;
  count?: number;
  canRollback?: boolean;
  /** 来自前端自己记的旧列表，没有状态信息 */
  legacy?: boolean;
}

/** 存储里读出来的东西类型不可信：只留 https 字符串。 */
function parseUrlList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((u): u is string => typeof u === 'string' && /^https:\/\//i.test(u)))];
}

function parseSubscriptions(value: unknown): SubRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SubRow[] = [];
  for (const v of value as unknown[]) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Partial<RuleSubscriptionInfo>;
    if (typeof o.url !== 'string') continue;
    rows.push({
      url: o.url,
      version: typeof o.version === 'string' || typeof o.version === 'number' ? o.version : null,
      updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : undefined,
      lastError: typeof o.lastError === 'string' && o.lastError ? o.lastError : undefined,
      count: typeof o.count === 'number' && Number.isFinite(o.count) ? o.count : 0,
      canRollback: o.canRollback === true,
    });
  }
  return rows;
}

/** 内容版本是 sha256:<64 位>，界面上只显示前 8 位。 */
function shortVersion(v: string | number): string {
  const s = String(v);
  return /^sha256:[0-9a-f]{64}$/i.test(s) ? s.slice(0, 15) : s.length > 32 ? s.slice(0, 32) + '…' : s;
}

const CSS = `
.adv { display: grid; gap: 14px; }
.adv .card { padding: 16px 18px; }
.adv h3 { margin: 0 0 4px; font-size: 14.5px; }
.adv .hint { color: var(--muted); font-size: 12.5px; margin: 0 0 12px; }
.adv .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 16px; }
.adv label.f { display: grid; gap: 4px; font-size: 12.5px; color: var(--ink-2); }
.adv label.f input, .adv label.f select, .adv label.f textarea { min-width: 0; width: 100%; }
.adv .wide { grid-column: 1 / -1; }
.adv .acts { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.adv .msg { font-size: 12.5px; color: var(--muted); }
.adv .msg.ok { color: var(--good); }
.adv .msg.bad { color: var(--critical); }
.adv table { width: 100%; border-collapse: collapse; font-size: 13px; }
.adv th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.adv td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.adv td code { font-size: 12px; }
.adv .chip { font-size: 11px; padding: 1px 7px; border-radius: 99px; background: var(--hover); color: var(--ink-2); }
.adv .st { display: flex; gap: 22px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
.adv .st b { color: var(--ink); font-weight: 600; }
.adv .note { color: var(--muted); font-size: 12.5px; background: var(--hover); border-radius: 8px; padding: 10px 12px; }
.adv .check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--ink); }
`;

function msgEl() {
  return h('span', { class: 'msg' });
}
function say(el: HTMLElement, kind: '' | 'ok' | 'bad', text: string) {
  el.className = 'msg' + (kind ? ' ' + kind : '');
  el.textContent = text;
}
async function attempt(el: HTMLElement, busy: string, fn: () => Promise<string>) {
  say(el, '', busy);
  try {
    say(el, 'ok', await fn());
  } catch (e) {
    say(el, 'bad', L('失败：', 'Failed: ') + String((e as Error).message ?? e));
  }
}
const field = (label: string, control: Node, wide = false) => h('label', { class: 'f' + (wide ? ' wide' : '') }, label, control);
const input = (type: string, placeholder = '', value = '') => {
  const i = h('input', { type, placeholder, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  i.value = value;
  return i;
};
const lines = (s: string) => s.split(/\n+/).map((x) => x.trim()).filter(Boolean);

export async function mountAdvanced(main: HTMLElement): Promise<void> {
  main.append(h('style', null, CSS), h('h1', null, L('高级', 'Advanced')), h('p', { class: 'lead' }, L('站点规则、同步备份、词典与词对齐。', 'Site rules, sync and backup, dictionary and word alignment.')));
  const wrap = h('div', { class: 'adv' });
  main.append(wrap);
  let caps: BackendCapabilities;
  try {
    caps = await rpc('backend:capabilities', undefined);
  } catch {
    wrap.append(h('div', { class: 'note' }, L('当前后端不支持这些功能（需要后端 v2）。', 'This backend does not support these features (needs backend v2).')));
    return;
  }
  wrap.append(await rulesCard(), await syncCard(caps), backupCard(), dictCard(caps));
}

/* ------------------------------------------------------------------ */
/* 站点规则                                                             */
/* ------------------------------------------------------------------ */

async function rulesCard(): Promise<HTMLElement> {
  const card = h('div', { class: 'card' }, h('h3', null, L('站点规则', 'Site rules')), h('p', { class: 'hint' }, L('告诉翻译器某个网站的正文在哪、哪些部分不翻、要不要自动翻译。规则只能是数据，不能包含脚本。', 'Tell the translator where a site’s main content is, what not to translate and whether to translate automatically. Rules are data only — no scripts.')));
  const table = h('div');
  const form = h('div');
  const msg = msgEl();
  card.append(table, form);

  const editor = (rule?: SiteRule) => {
    const match = h('textarea', { placeholder: 'example.com\n*.example.org' }) as HTMLTextAreaElement;
    const include = h('textarea', { placeholder: 'article, main .content' }) as HTMLTextAreaElement;
    const exclude = h('textarea', { placeholder: '.comments, nav' }) as HTMLTextAreaElement;
    const waitFor = input('text', L('.post-body（页面加载后等这个元素出现再翻译）', '.post-body (wait for this element after the page loads, then translate)'), rule?.waitFor ?? '');
    const display = h('select') as HTMLSelectElement;
    for (const [v, l] of [['append', L('双语对照', 'Bilingual')], ['replace', L('只显示译文', 'Translation only')]] as const) display.append(h('option', { value: v, selected: (rule?.display ?? 'append') === v }, l));
    const auto = h('input', { type: 'checkbox' }) as HTMLInputElement;
    auto.checked = !!rule?.autoTranslate;
    match.value = rule?.match.join('\n') ?? '';
    include.value = rule?.include?.join('\n') ?? '';
    exclude.value = rule?.exclude?.join('\n') ?? '';
    const save = h('button', { class: 'btn primary', type: 'button' }, rule ? L('保存修改', 'Save changes') : L('添加规则', 'Add rule'));
    const cancel = h('button', { class: 'btn', type: 'button' }, L('取消', 'Cancel'));
    save.addEventListener('click', () =>
      attempt(msg, L('正在保存…', 'Saving…'), async () => {
        const m = lines(match.value);
        if (!m.length) throw new Error(L('至少填一个网站', 'Enter at least one site'));
        await rpc('rules:save', {
          rule: {
            id: rule?.id ?? uid('rule'),
            match: m,
            include: lines(include.value).length ? lines(include.value) : undefined,
            exclude: lines(exclude.value).length ? lines(exclude.value) : undefined,
            waitFor: waitFor.value.trim() || undefined,
            display: display.value as SiteRule['display'],
            autoTranslate: auto.checked || undefined,
            source: 'local',
          },
        });
        form.replaceChildren();
        await refresh();
        return L('已保存', 'Saved');
      }),
    );
    cancel.addEventListener('click', () => form.replaceChildren());
    form.replaceChildren(
      h('div', { class: 'grid', style: 'margin-top:12px' },
        field(L('适用的网站（每行一个，支持 *）', 'Sites (one per line, * allowed)'), match),
        field(L('只翻译这些区域（CSS 选择器，可空）', 'Translate only these areas (CSS selectors, optional)'), include),
        field(L('不翻译这些区域（CSS 选择器，可空）', 'Never translate these areas (CSS selectors, optional)'), exclude),
        field(L('等待元素出现', 'Wait for element'), waitFor),
        field(L('显示方式', 'Display'), display),
        h('label', { class: 'check' }, auto, L('打开这个网站时自动翻译', 'Translate automatically when opening this site')),
      ),
      h('div', { class: 'acts' }, save, cancel, msg),
    );
  };

  const subsBox = h('div', { style: 'margin-top:16px' });
  card.append(subsBox);

  const refresh = async () => {
    // 规则可能刚改过：让网页里缓存的规则失效（下次翻译重新向后台查）
    void clearRuleCache();
    let rules: SiteRule[] = [];
    try {
      rules = await rpc('rules:list', undefined);
    } catch (e) {
      table.replaceChildren(h('div', { class: 'msg bad' }, L('读取规则失败：', 'Could not load rules: ') + String((e as Error).message)));
      return;
    }
    const tbody = h('tbody');
    const SRC: Record<SiteRule['source'], string> = { local: L('本地', 'Local'), subscription: L('订阅', 'Subscribed'), builtin: L('内置', 'Built-in') };
    for (const r of rules) {
      const acts = h('td', { style: 'white-space:nowrap;text-align:right' });
      if (r.source === 'local') {
        const e = h('button', { class: 'btn small', type: 'button' }, L('编辑', 'Edit'));
        e.addEventListener('click', () => editor(r));
        const d = h('button', { class: 'btn small', type: 'button', style: 'margin-left:6px' }, L('删除', 'Delete'));
        d.addEventListener('click', () => attempt(msg, L('正在删除…', 'Deleting…'), async () => (await rpc('rules:remove', { id: r.id }), await refresh(), L('已删除', 'Deleted'))));
        acts.append(e, d);
      }
      tbody.append(h('tr', null,
        h('td', null, h('code', null, r.match.join(', '))),
        h('td', null, h('span', { class: 'chip' }, SRC[r.source])),
        h('td', null, [r.include?.length ? L(`只翻：${r.include.join(', ')}`, `Only: ${r.include.join(', ')}`) : '', r.exclude?.length ? L(`不翻：${r.exclude.join(', ')}`, `Skip: ${r.exclude.join(', ')}`) : '', r.autoTranslate ? L('自动翻译', 'Auto-translate') : '', r.display === 'replace' ? L('只显示译文', 'Translation only') : ''].filter(Boolean).join(' · ') || '—'),
        acts,
      ));
    }
    const add = h('button', { class: 'btn small', type: 'button' }, L('＋ 新建规则', '＋ New rule'));
    add.addEventListener('click', () => editor());
    table.replaceChildren(
      rules.length ? h('table', null, h('thead', null, h('tr', null, h('th', null, L('网站', 'Site')), h('th', null, L('来源', 'Source')), h('th', null, L('内容', 'Content')), h('th', null, ''))), tbody) : h('div', { class: 'msg' }, L('还没有规则。', 'No rules yet.')),
      h('div', { class: 'acts' }, add, msg),
    );
  };
  await refresh();

  // 订阅：以后端 rules:subscriptions 为准；旧后端没有这个接口时，退回前端自己记的地址列表
  const subUrl = input('url', 'https://example.com/rules.json');
  const subMsg = msgEl();
  let legacy = false;
  const loadSubs = async (): Promise<SubRow[]> => {
    try {
      const rows = parseSubscriptions(await rpc('rules:subscriptions', undefined));
      legacy = false;
      return rows;
    } catch {
      legacy = true;
      const got: Record<string, unknown> = await chrome.storage.local.get(SUBS_KEY);
      return parseUrlList(got[SUBS_KEY]).map((url) => ({ url, legacy: true }));
    }
  };
  const renderSubs = async () => {
    const subs = await loadSubs();
    const rows = subs.map((sub) => {
      const r = h('button', { class: 'btn small', type: 'button' }, L('刷新', 'Refresh'));
      r.addEventListener('click', () => attempt(subMsg, L('正在刷新…', 'Refreshing…'), async () => (await rpc('rules:refresh', { url: sub.url }), await refresh(), await renderSubs(), L('已更新', 'Updated'))));
      const acts = h('td', { style: 'white-space:nowrap;text-align:right' }, r);
      if (sub.legacy || sub.canRollback) {
        const b = h('button', { class: 'btn small', type: 'button', style: 'margin-left:6px' }, L('回滚到上一版', 'Roll back to the previous version'));
        b.addEventListener('click', () => attempt(subMsg, L('正在回滚…', 'Rolling back…'), async () => (await rpc('rules:rollback', { url: sub.url }), await refresh(), await renderSubs(), L('已回滚', 'Rolled back'))));
        acts.append(b);
      }
      const info = sub.legacy ? '' : [
        sub.version !== null && sub.version !== undefined ? L(`版本 ${shortVersion(sub.version)}`, `Version ${shortVersion(sub.version)}`) : L('尚无有效版本', 'No valid version yet'),
        L(`${sub.count ?? 0} 条规则`, `${sub.count ?? 0} rules`),
        sub.updatedAt ? L(`更新于 ${new Date(sub.updatedAt).toLocaleString('zh-CN', { hour12: false })}`, `Updated ${new Date(sub.updatedAt).toLocaleString('en', { hour12: false })}`) : '',
      ].filter(Boolean).join(' · ');
      return h('tr', null,
        h('td', null, h('code', null, sub.url),
          info ? h('div', { class: 'msg' }, info) : null,
          sub.lastError ? h('div', { class: 'msg bad' }, L('上次更新失败：', 'Last update failed: ') + sub.lastError) : null),
        acts);
    });
    const add = h('button', { class: 'btn', type: 'button' }, L('订阅', 'Subscribe'));
    add.addEventListener('click', () =>
      attempt(subMsg, L('正在订阅…', 'Subscribing…'), async () => {
        const u = subUrl.value.trim();
        if (!/^https:\/\//i.test(u)) throw new Error(L('只支持 https 地址', 'Only https addresses are supported'));
        await rpc('rules:subscribe', { url: u });
        if (legacy) {
          // 旧后端没有订阅列表接口，前端自己记一份（只存字符串地址）
          const got: Record<string, unknown> = await chrome.storage.local.get(SUBS_KEY);
          const list = parseUrlList(got[SUBS_KEY]);
          if (!list.includes(u)) await chrome.storage.local.set({ [SUBS_KEY]: [...list, u] });
        }
        subUrl.value = '';
        await refresh();
        await renderSubs();
        return L('已订阅', 'Subscribed');
      }),
    );
    subsBox.replaceChildren(
      h('h3', { style: 'font-size:13.5px' }, L('规则订阅', 'Rule subscriptions')),
      h('p', { class: 'hint' }, L('订阅别人维护的规则列表（JSON），定期自动更新；更新出问题时可以回滚。', 'Subscribe to rule lists (JSON) maintained by others; they update automatically, and you can roll back if an update breaks something.')),
      rows.length ? h('table', null, h('tbody', null, ...rows)) : h('div', { class: 'msg' }, L('还没有订阅。', 'No subscriptions yet.')),
      h('div', { class: 'acts' }, subUrl, add, subMsg),
    );
    subUrl.style.minWidth = '320px';
  };
  await renderSubs();
  return card;
}

/* ------------------------------------------------------------------ */
/* 同步与备份                                                           */
/* ------------------------------------------------------------------ */

async function syncCard(caps: BackendCapabilities): Promise<HTMLElement> {
  const core = await loadCoreSettings();
  const st = caps.sync;
  const url = input('url', 'https://dav.example.com/remote.php/dav/files/me/', core.sync?.url ?? '');
  const user = input('text', L('用户名', 'Username'));
  const pass = input('password', L('密码或应用专用密码', 'Password or app password'));
  const withSecrets = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const phrase = input('password', L('用来加密密钥的口令（至少 8 位）', 'Passphrase used to encrypt keys (at least 8 characters)'));
  const phraseField = field(L('加密口令', 'Encryption passphrase'), phrase);
  phraseField.style.display = 'none';
  withSecrets.addEventListener('change', () => (phraseField.style.display = withSecrets.checked ? '' : 'none'));
  const msg = msgEl();
  const save = h('button', { class: 'btn primary', type: 'button' }, L('保存并启用', 'Save and enable'));
  const run = h('button', { class: 'btn', type: 'button' }, L('立即同步', 'Sync now'));
  const off = h('button', { class: 'btn', type: 'button' }, L('停用同步', 'Turn off sync'));
  save.addEventListener('click', () =>
    attempt(msg, L('正在连接…', 'Connecting…'), async () => {
      if (!url.value.trim()) throw new Error(L('请填写 WebDAV 地址', 'Enter the WebDAV address'));
      if (withSecrets.checked && phrase.value.length < 8) throw new Error(L('加密口令至少 8 位', 'The passphrase needs at least 8 characters'));
      await rpc('sync:configure', {
        enabled: true,
        url: url.value.trim(),
        username: user.value.trim() || undefined,
        password: pass.value || undefined,
        syncSecrets: withSecrets.checked,
        passphrase: withSecrets.checked ? phrase.value : undefined,
      });
      pass.value = '';
      phrase.value = '';
      await rpc('sync:run', undefined);
      return L('已启用，并完成一次同步', 'Enabled, and synced once');
    }),
  );
  run.addEventListener('click', () => attempt(msg, L('正在同步…', 'Syncing…'), async () => (await rpc('sync:run', undefined), L('同步完成', 'Sync complete'))));
  off.addEventListener('click', () => attempt(msg, L('正在停用…', 'Turning off…'), async () => (await rpc('sync:configure', { enabled: false }), L('已停用', 'Turned off'))));
  const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : L('从未', 'Never');
  return h('div', { class: 'card' },
    h('h3', null, L('WebDAV 同步', 'WebDAV sync')),
    h('p', { class: 'hint' }, L('在多台电脑之间同步设置、站点规则、译文记忆和用量计数。密钥默认不同步；勾选后用你的口令加密再上传。', 'Sync settings, site rules, translation memory and usage counters across computers. Keys are not synced by default; if checked, they are encrypted with your passphrase before upload.')),
    h('div', { class: 'st' },
      h('span', null, L('状态：', 'Status: '), h('b', null, st.enabled ? L('已启用', 'On') : L('未启用', 'Off'))),
      h('span', null, L('上次同步：', 'Last sync: '), h('b', null, when)),
      st.lastError ? h('span', { style: 'color:var(--critical)' }, L('上次出错：', 'Last error: ') + st.lastError) : null,
    ),
    h('div', { class: 'grid' }, field(L('WebDAV 地址', 'WebDAV address'), url, true), field(L('用户名', 'Username'), user), field(L('密码', 'Password'), pass),
      h('label', { class: 'check wide' }, withSecrets, L('同时同步翻译服务的密钥（加密）', 'Also sync service keys (encrypted)')), phraseField),
    h('div', { class: 'acts' }, save, run, off, msg),
  );
}

function backupCard(): HTMLElement {
  const phrase = input('password', L('备份口令（至少 8 位，恢复时要用）', 'Backup passphrase (at least 8 characters, needed to restore)'));
  const msg = msgEl();
  const exp = h('button', { class: 'btn', type: 'button' }, L('导出密钥备份', 'Export key backup'));
  exp.addEventListener('click', () =>
    attempt(msg, L('正在导出…', 'Exporting…'), async () => {
      if (phrase.value.length < 8) throw new Error(L('口令至少 8 位', 'The passphrase needs at least 8 characters'));
      const { archive } = await rpc('secrets:export', { passphrase: phrase.value });
      const a = h('a', { href: URL.createObjectURL(new Blob([archive], { type: 'application/json' })), download: `yi-secrets-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return L('已导出（文件已加密）', 'Exported (the file is encrypted)');
    }),
  );
  const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
  const imp = h('button', { class: 'btn', type: 'button' }, L('从备份恢复…', 'Restore from backup…'));
  imp.addEventListener('click', () => file.click());
  file.addEventListener('change', () =>
    attempt(msg, L('正在恢复…', 'Restoring…'), async () => {
      const f = file.files?.[0];
      if (!f) throw new Error(L('没有选择文件', 'No file selected'));
      if (phrase.value.length < 8) throw new Error(L('请先填写导出时用的口令', 'Enter the passphrase used for the export first'));
      await rpc('secrets:import', { passphrase: phrase.value, archive: await f.text() });
      file.value = '';
      return L('已恢复，请到「翻译服务」里检查', 'Restored — check them under Services');
    }),
  );
  return h('div', { class: 'card' },
    h('h3', null, L('密钥备份', 'Key backup')),
    h('p', { class: 'hint' }, L('把各家翻译服务的密钥导出成一个加密文件，换电脑或重装扩展时恢复。不知道口令就无法解开。', 'Export all service keys to one encrypted file to restore them on a new computer or after reinstalling. It cannot be opened without the passphrase.')),
    h('div', { class: 'grid' }, field(L('口令', 'Passphrase'), phrase)),
    h('div', { class: 'acts' }, exp, imp, file, msg),
  );
}

/* ------------------------------------------------------------------ */
/* 词典与词对齐                                                         */
/* ------------------------------------------------------------------ */

function dictCard(caps: BackendCapabilities): HTMLElement {
  const d = caps.dictionary;
  const al = caps.alignment;
  const dmsg = msgEl();
  const file = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none' }) as HTMLInputElement;
  const pick = h('button', { class: 'btn', type: 'button' }, L('导入 ECDICT 词典（CSV）…', 'Import ECDICT dictionary (CSV)…'));
  pick.addEventListener('click', () => file.click());
  file.addEventListener('change', () =>
    attempt(dmsg, L('正在导入，词条多时需要一两分钟…', 'Importing — a large dictionary takes a minute or two…'), async () => {
      const f = file.files?.[0];
      if (!f) throw new Error(L('没有选择文件', 'No file selected'));
      const r = await rpc('dict:import', { csv: await f.text() });
      file.value = '';
      return L(`已导入 ${r.entries.toLocaleString('zh-CN')} 个词条`, `Imported ${r.entries.toLocaleString('en')} entries`);
    }),
  );

  const amsg = msgEl();
  const on = h('input', { type: 'checkbox' }) as HTMLInputElement;
  on.checked = al.ready || !!al.loading;
  const remote = input('url', L('远程节点地址（可空，空则在本机 CPU 上算）', 'Remote node address (optional; empty runs on this computer’s CPU)'));
  const token = input('password', L('访问令牌', 'Access token'));
  const save = h('button', { class: 'btn', type: 'button' }, L('保存', 'Save'));
  save.addEventListener('click', () =>
    attempt(amsg, L('正在保存…', 'Saving…'), async () => {
      await rpc('align:configure', { enabled: on.checked, remoteUrl: remote.value.trim() || undefined, token: token.value || undefined });
      token.value = '';
      return L('已保存', 'Saved');
    }),
  );
  const alState = al.error ? L(`出错：${al.error}`, `Error: ${al.error}`) : al.loading ? L('正在加载模型…', 'Loading model…') : al.ready ? L(`已就绪${al.model ? ` · ${al.model}` : ''}`, `Ready${al.model ? ` · ${al.model}` : ''}`) : L('未启用', 'Off');
  return h('div', { class: 'card' },
    h('h3', null, L('词典与词对齐', 'Dictionary and word alignment')),
    h('p', { class: 'hint' }, L('词典用于划词时显示释义；词对齐用于原文和译文之间的联动高亮（能对到具体的词）。', 'The dictionary shows definitions for selected words; word alignment powers the linked highlighting between original and translation (down to individual words).')),
    h('div', { class: 'st' },
      h('span', null, L('词典：', 'Dictionary: '), h('b', null, d.ready ? L(`已就绪 · ${(d.entries ?? 0).toLocaleString('zh-CN')} 词`, `Ready · ${(d.entries ?? 0).toLocaleString('en')} words`) : L('未导入', 'Not imported'))),
      h('span', null, L('词对齐：', 'Word alignment: '), h('b', null, alState)),
    ),
    h('div', { class: 'acts', style: 'margin-top:0' }, pick, file, dmsg),
    h('div', { class: 'grid', style: 'margin-top:14px' },
      h('label', { class: 'check wide' }, on, L('启用词对齐模型（不启用时只按相同的词和数字对齐）', 'Enable the word-alignment model (otherwise only identical words and numbers are matched)')),
      field(L('远程节点', 'Remote node'), remote),
      field(L('令牌', 'Token'), token),
    ),
    h('div', { class: 'acts' }, save, amsg),
  );
}
