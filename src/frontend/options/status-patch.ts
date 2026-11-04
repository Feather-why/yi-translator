/** 状态快照只更新变化的文本和属性。服务按 id 复用行与按钮，避免五秒刷新打断键盘操作。 */
export function patchStatusChildren(parent: Element, fresh: Node[]): void {
  const focused = parent.ownerDocument.activeElement;
  const key = (node: Node) => node instanceof Element ? node.getAttribute('data-status-key') : null;
  const same = (left: Node, right: Node) => left.nodeType === right.nodeType && left.nodeName === right.nodeName && key(left) === key(right);
  const old = [...parent.childNodes];
  const keyed = new Map(old.filter((node) => key(node)).map((node) => [key(node), node]));
  const used = new Set<Node>();
  fresh.forEach((desired, index) => {
    const id = key(desired);
    const existing = id ? keyed.get(id) : old[index];
    const kept = existing && !used.has(existing) && same(existing, desired) ? existing : desired;
    used.add(kept);
    if (kept !== desired) patch(kept, desired);
    if (parent.childNodes[index] !== kept) parent.insertBefore(kept, parent.childNodes[index] ?? null);
  });
  for (const child of [...parent.childNodes]) if (!used.has(child)) child.remove();
  // 排名变化时移动的是原按钮，Chromium 的 insertBefore 仍可能清焦点，原位恢复。
  if (focused instanceof HTMLElement && focused.isConnected && parent.contains(focused) && parent.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
}

function patch(current: Node, fresh: Node): void {
  if (current === fresh) return;
  if (!(current instanceof Element) || !(fresh instanceof Element)) {
    if (current.nodeValue !== fresh.nodeValue) current.nodeValue = fresh.nodeValue;
    return;
  }
  for (const attr of [...current.attributes]) if (!fresh.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  for (const attr of [...fresh.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  if (current instanceof HTMLElement && fresh instanceof HTMLElement) {
    // 事件处理同步到新快照的状态，防止「暂停」变「恢复」后仍执行旧动作。
    current.onclick = fresh.onclick;
    current.onmousemove = fresh.onmousemove;
    current.onmouseleave = fresh.onmouseleave;
  }
  patchStatusChildren(current, [...fresh.childNodes]);
}
