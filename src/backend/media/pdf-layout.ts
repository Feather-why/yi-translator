export interface TextBox { text: string; box: [number, number, number, number] }

/** 先按行再按栏分组，避免把相同高度的左右两栏拼成一句。 */
export function groupPdfText(items: TextBox[], page: number): { id: string; source: string; box: [number, number, number, number] }[] {
  const lines: TextBox[] = [];
  for (const item of items.filter((value) => value.text.trim()).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const height = Math.max(1, item.box[3] - item.box[1]);
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.box[1] - item.box[1]) <= Math.min(5, height * 0.4) && item.box[0] - previous.box[2] < height * 3) {
      previous.text += (previous.text.endsWith(' ') || item.text.startsWith(' ') ? '' : ' ') + item.text;
      previous.box = [Math.min(previous.box[0], item.box[0]), Math.min(previous.box[1], item.box[1]), Math.max(previous.box[2], item.box[2]), Math.max(previous.box[3], item.box[3])];
    } else lines.push({ text: item.text, box: [...item.box] });
  }
  const paragraphs: TextBox[] = [];
  for (const line of lines) {
    const height = Math.max(1, line.box[3] - line.box[1]);
    const prior = [...paragraphs].reverse().find((candidate) => Math.abs(candidate.box[0] - line.box[0]) < height * 2 && line.box[1] - candidate.box[3] >= -height * 0.2 && line.box[1] - candidate.box[3] < height * 0.8 && line.text.length + candidate.text.length < 1800);
    if (prior) { prior.text += ' ' + line.text; prior.box[2] = Math.max(prior.box[2], line.box[2]); prior.box[3] = Math.max(prior.box[3], line.box[3]); }
    else paragraphs.push({ text: line.text, box: [...line.box] });
  }
  return paragraphs.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]).map((item, index) => ({ id: `p${page}-${index}`, source: item.text, box: item.box }));
}
