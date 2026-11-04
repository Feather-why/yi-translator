/** 后端支持哪些媒体能力（B5 之前的后端没有 backend:capabilities，视为都不支持）。 */
import { rpc } from '../../shared/rpc';

export interface MediaCaps {
  ocr: boolean;
  subtitles: boolean;
  pdf: boolean;
  cancel?: boolean;
  pdfSessions?: boolean;
}

let cached: Promise<MediaCaps> | null = null;

export function mediaCaps(): Promise<MediaCaps> {
  if (!cached) {
    cached = rpc('backend:capabilities', undefined)
      .then((c) => c.media)
      .catch(() => ({ ocr: false, subtitles: false, pdf: false }));
  }
  return cached;
}
