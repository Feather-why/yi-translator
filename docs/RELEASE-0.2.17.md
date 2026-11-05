# Yi 0.2.17

修复在奥尔堡大学招聘页开启翻译后一直显示“正在扫描页面”的问题。

- 如果网站在整页上设置免译标记，点击悬浮球仍可翻译当前页面。单独段落的免译标记、编辑区域和扩展的排除规则仍然生效。
- “只翻正文”模式识别文章时会排除隐藏的 Cookie 详情面板。打开招聘页后可以从职位标题开始阅读，向下滚动时会继续翻译后面的内容。

使用独立 Edge 和本机模型，在两个 AAU 招聘页验证了职位标题、首段、中段和末尾长段的中文译文，以及关闭翻译后的原文和链接还原。[用户反馈的职位页](https://www.vacancies.aau.dk/phd-positions/show-vacancy/vacancyId/981852) · [第二个职位页](https://www.vacancies.aau.dk/phd-positions/show-vacancy/vacancyId/983659)

更新已解压安装的扩展时，请将 `translate-ext-0.2.17-chrome.zip` 解压到原扩展目录，在扩展管理页点“重新加载”，然后刷新招聘页。技术记录见[交接文档第 54 节](HANDOFF-BACKEND.md#54-带整页免译标记的招聘页)。
