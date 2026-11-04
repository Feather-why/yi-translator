import { startYoutube } from '../frontend/youtube';

export default defineContentScript({
  matches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
  runAt: 'document_start',
  main() {
    void startYoutube();
  },
});
