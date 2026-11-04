import { installYoutubeHook } from '../frontend/youtube/hook';

// 运行在 YouTube 页面自己的环境里，在播放器初始化之前包好 fetch / XHR，拿到播放器自己请求的字幕。
export default defineContentScript({
  matches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installYoutubeHook();
  },
});
