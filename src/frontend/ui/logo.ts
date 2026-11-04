/**
 * 图标：一对中文引号「」框住两行字——上一行是原文，下一行（强调色、短一点）是译文，
 * 对应「一句原文一句译文」。全部用描边，随 currentColor 和 --logo-accent 变色。
 */
export function logoSvg(opts: { size?: number; lines?: 1 | 2 } = {}): string {
  const size = opts.size ?? 22;
  const lines =
    opts.lines === 1
      ? '<path d="M8.6 12.2h6.8" stroke="var(--logo-accent, currentColor)" stroke-width="2.2"/>'
      : '<path d="M8.6 10.4h6.8" stroke="currentColor" stroke-width="2"/><path d="M8.6 14h4.4" stroke="var(--logo-accent, currentColor)" stroke-width="2.2"/>';
  return (
    `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    '<path d="M10.2 4.6H6.6a2 2 0 0 0-2 2v3.6" stroke="currentColor" stroke-width="2.2"/>' +
    '<path d="M13.8 19.4h3.6a2 2 0 0 0 2-2v-3.6" stroke="currentColor" stroke-width="2.2"/>' +
    lines +
    '</svg>'
  );
}

export function logoElement(opts?: { size?: number; lines?: 1 | 2 }): SVGSVGElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = logoSvg(opts);
  return wrap.firstElementChild as SVGSVGElement;
}
