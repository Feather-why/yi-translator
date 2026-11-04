interface InstallationActions {
  installMenus(): void | Promise<void>;
  getURL(path: string): string;
  open(url: string): Promise<unknown>;
}

/** 欢迎页与菜单独立启动，防止菜单注册失败让首次使用入口消失。 */
export async function handleInstallation(reason: string, actions: InstallationActions): Promise<void> {
  const tasks: Promise<unknown>[] = [Promise.resolve().then(() => actions.installMenus())];
  if (reason === 'install') tasks.push(Promise.resolve().then(() => actions.open(actions.getURL('options.html#welcome'))));
  // 安装/更新事件没有调用方接收拒绝；浏览器关闭、标签页创建失败都应在这里收拢。
  await Promise.allSettled(tasks);
}
