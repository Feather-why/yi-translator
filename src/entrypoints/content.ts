import { startContent } from '../frontend/content';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    void startContent();
  },
});
