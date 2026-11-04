/**
 * 只在没有 node_modules 的环境里做类型检查时用（见 typecheck/tsconfig.json）。
 * 正常开发请 `npm i` 后用 `npm run typecheck`，那时用的是 WXT 和 @types/chrome 的真类型。
 */

declare function defineContentScript(def: {
  matches: string[];
  runAt?: 'document_start' | 'document_end' | 'document_idle';
  allFrames?: boolean;
  world?: 'ISOLATED' | 'MAIN';
  main(ctx?: unknown): void | Promise<void>;
}): unknown;
declare function defineBackground(main: () => void): unknown;

declare namespace chrome {
  namespace alarms {
    interface Alarm { name: string; scheduledTime: number; periodInMinutes?: number }
    function create(name: string, info: { when?: number; periodInMinutes?: number }): Promise<void>;
    function clear(name: string): Promise<boolean>;
    function get(name: string): Promise<Alarm | undefined>;
    const onAlarm: ChromeEvent<(alarm: Alarm) => void>;
  }
  interface ChromeEvent<T extends (...args: any[]) => any> {
    addListener(cb: T): void;
    removeListener(cb: T): void;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      windowId: number;
    }
    function sendMessage(tabId: number, msg: unknown, options?: { frameId?: number }): Promise<any>;
    function create(p: { url: string; active?: boolean }): Promise<Tab>;
    function query(q: Record<string, unknown>): Promise<Tab[]>;
  }
  namespace runtime {
    interface MessageSender {
      tab?: chrome.tabs.Tab;
      id?: string;
      url?: string;
      frameId?: number;
      origin?: string;
    }
    interface Port {
      name: string;
      sender?: MessageSender;
      postMessage(msg: any): void;
      disconnect(): void;
      onMessage: ChromeEvent<(msg: any, port: Port) => void>;
      onDisconnect: ChromeEvent<(port: Port) => void>;
    }
    const id: string | undefined;
    const lastError: { message?: string } | undefined;
    function connect(info?: { name?: string }): Port;
    function sendMessage(msg: unknown): Promise<any>;
    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
    const onMessage: ChromeEvent<(msg: any, sender: MessageSender, sendResponse: (r?: any) => void) => boolean | void>;
    const onConnect: ChromeEvent<(port: Port) => void>;
    const onInstalled: ChromeEvent<(details: { reason: string }) => void>;
  }
  namespace storage {
    interface StorageChange {
      oldValue?: any;
      newValue?: any;
    }
    const local: {
      get(keys?: string | string[] | null): Promise<Record<string, any>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    const onChanged: ChromeEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
  }
  namespace action {
    const onClicked: ChromeEvent<(tab: chrome.tabs.Tab) => void>;
  }
  namespace commands {
    const onCommand: ChromeEvent<(command: string, tab?: chrome.tabs.Tab) => void>;
  }
  namespace contextMenus {
    function create(p: { id: string; title: string; contexts: string[]; documentUrlPatterns?: string[]; targetUrlPatterns?: string[] }): void;
    function removeAll(): Promise<void>;
    const onClicked: ChromeEvent<(info: { menuItemId: string | number; selectionText?: string; srcUrl?: string; linkUrl?: string; pageUrl?: string; frameUrl?: string; frameId?: number }, tab?: chrome.tabs.Tab) => void>;
  }
}
