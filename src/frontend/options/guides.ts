/**
 * 新手指引里的详细教程：每家翻译服务怎么注册、开通、拿密钥、填进扩展，以及本地模型怎么部署。
 *
 * 写法约定：步骤正文支持 `代码`、**加粗**、[链接文字](https://…)；不支持别的 HTML。
 * 核实日期：2026-11-04（各家官网 / 官方文档）。政策变化快，教程里会写「以控制台为准」的地方都是确实会变的。
 */
import { L } from '../i18n';

export interface GuideStep {
  title: string;
  body: string;
}

export interface ApiGuide {
  id: string;
  name: string;
  /** 对应的内置服务 id（直接在指引里填密钥）；没有就用 preset 新建一个 OpenAI 兼容服务。 */
  providerId?: string;
  preset?: { url: string; model: string; modelHint: string };
  kind: 'mt' | 'llm' | 'self';
  /** 卡片上的一句话。 */
  tagline: string;
  free: string;
  needs: string;
  bestFor: string;
  /** 在中国大陆 / 欧洲是否方便，给用户选的时候参考。 */
  region: string;
  steps: GuideStep[];
  tips?: string[];
  links: { label: string; url: string }[];
}

/** 函数：界面语言定了以后再生成文字。 */
export const apiGuides = (): ApiGuide[] => [
  {
    id: 'microsoft',
    name: L('微软 Azure 翻译', 'Microsoft Azure Translator'),
    providerId: 'microsoft',
    kind: 'mt',
    tagline: L('免费额度最多的正规机翻，速度快，适合当高速档主力。', 'The biggest free quota among official MT services and fast — a good main fast-tier engine.'),
    free: L('每月 200 万字符（F0 免费层）', '2 million characters a month (F0 free tier)'),
    needs: L('微软账号；Azure 注册要手机号和一张信用卡 / 借记卡做身份验证（免费层不扣钱）', 'A Microsoft account; Azure sign-up needs a phone number and a credit / debit card for identity checks (the free tier is not charged)'),
    bestFor: L('整页翻译、日常浏览', 'Whole pages, everyday browsing'),
    region: L('全球可用，中国大陆可直连', 'Available worldwide, including mainland China'),
    steps: [
      {
        title: L('注册 Azure 账号', 'Create an Azure account'),
        body: L('打开 [Azure 门户](https://portal.azure.com/)，用微软账号登录。第一次用会让你创建 Azure 订阅：选**免费账户**（Free account）或**即用即付**（Pay-As-You-Go）都可以，按提示填手机号验证码和银行卡做身份验证。学生可以用学校邮箱开 **Azure for Students**，不需要银行卡。', 'Open the [Azure portal](https://portal.azure.com/) and sign in with a Microsoft account. The first time, it asks you to create an Azure subscription: either a **Free account** or **Pay-As-You-Go** works; follow the prompts to verify your phone and card. Students can use a school email for **Azure for Students**, no card needed.'),
      },
      {
        title: L('创建「Translator」资源', 'Create a “Translator” resource'),
        body: L('在门户顶部搜索框输入 `Translator`，点搜索结果里的 **Translator**（翻译器），再点 **Create / 创建**。表单这样填：\n- **Subscription**：刚建的订阅\n- **Resource group**：点「Create new」随便起个名字，比如 `translate`\n- **Region**：选 **Global**（全局）。如果你想选具体地区（如 East Asia、West Europe），记住它，后面要填\n- **Name**：随便起，比如 `my-translate-01`（全网唯一，被占用就换一个）\n- **Pricing tier**：一定选 **Free F0**\n然后点 **Review + create**，再点 **Create**，等一两分钟部署完成，点 **Go to resource**。', 'Type `Translator` into the search box at the top of the portal, pick **Translator** in the results, then click **Create**. Fill in the form like this:\n- **Subscription**: the one you just created\n- **Resource group**: click “Create new” and give it any name, e.g. `translate`\n- **Region**: choose **Global**. If you pick a specific region (e.g. East Asia, West Europe), remember it — you will need it later\n- **Name**: anything, e.g. `my-translate-01` (must be globally unique; try another if taken)\n- **Pricing tier**: be sure to choose **Free F0**\nThen click **Review + create**, then **Create**, wait a minute or two for the deployment and click **Go to resource**.'),
      },
      {
        title: L('复制密钥和地域', 'Copy the key and region'),
        body: L('在资源页面左侧菜单 **Resource Management → Keys and Endpoint**（密钥和终结点）。复制 **KEY 1**（KEY 2 也行）。下面的 **Location/Region** 记下来：选了 Global 时可以不填，选了具体地区（如 `eastasia`、`westeurope`）时一定要填。', 'In the resource’s left menu open **Resource Management → Keys and Endpoint**. Copy **KEY 1** (KEY 2 works too). Note the **Location/Region** below it: you can leave it empty for Global, but it is required for a specific region (e.g. `eastasia`, `westeurope`).'),
      },
      {
        title: L('填进扩展并测试', 'Fill it in and test'),
        body: L('在下面的表单里：**订阅密钥** 粘贴 KEY 1；**资源地域** 填上一步的 Location/Region（Global 留空）。点「保存并测试」，看到「可用」就好了。', 'In the form below, paste KEY 1 into **订阅密钥** (subscription key) and the Location/Region from the previous step into **资源地域** (region; leave empty for Global). Click “Save and test” — when it says it works, you are done.'),
      },
    ],
    tips: [
      L('报错 401：多半是地域没填或填错（要全小写、没有空格，例如 `westeurope`）；或者刚创建的密钥还没生效，等一分钟再试。', 'Error 401: usually the region is missing or wrong (all lowercase, no spaces, e.g. `westeurope`), or a brand-new key is not active yet — wait a minute and try again.'),
      L('一个订阅里同一地区通常只能有一个免费 F0 资源；提示已存在时就用已有的那个。', 'A subscription usually allows only one free F0 resource per region; if it says one already exists, use that one.'),
      L('超出 200 万字符后 F0 会直接拒绝请求，不会扣费；扩展会自动换下一家。', 'Past 2 million characters F0 simply rejects requests and never charges you; the extension switches to the next service.'),
    ],
    links: [
      { label: L('Azure 门户', 'Azure portal'), url: 'https://portal.azure.com/' },
      { label: L('官方说明：创建 Translator 资源', 'Docs: create a Translator resource'), url: 'https://learn.microsoft.com/azure/ai-services/translator/create-translator-resource' },
      { label: L('价格与免费额度', 'Pricing and free quota'), url: 'https://azure.microsoft.com/pricing/details/translator/' },
    ],
  },
  {
    id: 'niutrans',
    name: L('小牛翻译', 'NiuTrans'),
    providerId: 'niutrans',
    kind: 'mt',
    tagline: L('国内机翻，注册最简单，每天都送免费额度。', 'Chinese MT service with the simplest sign-up and a free daily quota.'),
    free: L('每天 20 万字符（每日赠送 100 积分，1 积分 = 2000 字符）', '200,000 characters a day (100 free points daily, 1 point = 2,000 characters)'),
    needs: L('手机号注册即可', 'Just a phone number'),
    bestFor: L('中文用户的整页翻译、备用高速档', 'Whole pages for Chinese users, backup fast tier'),
    region: L('中国大陆服务，海外也能访问', 'Service in mainland China, reachable from abroad'),
    steps: [
      {
        title: L('注册小牛翻译开放平台', 'Sign up on the NiuTrans open platform'),
        body: L('打开 [小牛翻译开放平台](https://niutrans.com/)，右上角注册 / 登录（手机号 + 验证码）。', 'Open the [NiuTrans open platform](https://niutrans.com/) and sign up / log in at the top right (phone number + verification code).'),
      },
      {
        title: L('找到 API-KEY', 'Find the API-KEY'),
        body: L('登录后点右上角的 **控制台**，左侧菜单进入 **个人中心**（账号信息）。页面上的 **API-KEY** 默认是隐藏的，点旁边的显示 / 复制按钮把它复制下来。文本翻译只要 API-KEY，不需要 APPID。', 'After logging in click **控制台** (console) at the top right, then **个人中心** (account info) in the left menu. The **API-KEY** is hidden by default; use the show / copy button next to it. Text translation only needs the API-KEY, not the APPID.'),
      },
      {
        title: L('填进扩展并测试', 'Fill it in and test'),
        body: L('在下面的 **API Key** 里粘贴，点「保存并测试」。', 'Paste it into **API Key** below and click “Save and test”.'),
      },
    ],
    tips: [L('免费用户每秒最多 5 次请求、单次最多 5000 字符，扩展已经按这个限速。', 'Free users get at most 5 requests per second and 5,000 characters per request; the extension already respects this.'), L('每天的免费额度第二天自动恢复。', 'The daily free quota comes back the next day.')],
    links: [
      { label: L('小牛翻译开放平台', 'NiuTrans open platform'), url: 'https://niutrans.com/' },
      { label: L('官方：文本翻译与免费额度', 'Docs: text translation and free quota'), url: 'https://niutrans.com/documents/contents/trans_text' },
    ],
  },
  {
    id: 'deepl',
    name: 'DeepL',
    providerId: 'deepl',
    kind: 'mt',
    tagline: L('欧洲语言质量很好，但新用户的免费额度只有一次性的。', 'Very good for European languages, but new users only get a one-time free quota.'),
    free: L('新用户：API Developer 一次性 100 万字符（用完不重置）；以前开通 API Free 的老用户：每月 50 万字符', 'New users: API Developer, 1 million characters once (no reset); existing API Free users: 500,000 characters a month'),
    needs: L('DeepL 账号 + 一张受支持国家 / 地区的信用卡（只做验证，不扣钱）；中国大陆发行的卡不行', 'A DeepL account + a credit card from a supported country / region (only for verification, not charged); cards issued in mainland China do not work'),
    bestFor: L('英德法等欧洲语言的精确翻译', 'Accurate translation of English, German, French and other European languages'),
    region: L('欧洲、北美方便；中国大陆注册困难', 'Easy in Europe and North America; hard to sign up from mainland China'),
    steps: [
      {
        title: L('注册 DeepL API 账号', 'Create a DeepL API account'),
        body: L('打开 [DeepL API 页面](https://www.deepl.com/pro-api)，选免费的 **API Developer**（以前叫 API Free），点注册。注意：网页版的 DeepL Pro 订阅**不能**调用 API，要的是 API 套餐。按提示填邮箱、地址和信用卡（只用来防止重复注册）。', 'Open the [DeepL API page](https://www.deepl.com/pro-api), choose the free **API Developer** plan (formerly API Free) and sign up. Note: a DeepL Pro subscription for the web app does **not** include the API — you need an API plan. Enter your email, address and card as prompted (the card only prevents duplicate sign-ups).'),
      },
      {
        title: L('复制密钥', 'Copy the key'),
        body: L('登录后打开 [账户 → API Keys](https://www.deepl.com/your-account/keys)，复制那串密钥。免费 / Developer 密钥一般以 `:fx` 结尾。', 'After logging in open [Account → API Keys](https://www.deepl.com/your-account/keys) and copy the key. Free / Developer keys usually end with `:fx`.'),
      },
      {
        title: L('填进扩展并测试', 'Fill it in and test'),
        body: L('在下面的 **API 密钥** 里粘贴，点「保存并测试」。免费（`:fx` 结尾）和付费密钥都可以，扩展会自动选对应的接口地址。', 'Paste it into **API 密钥** (API key) below and click “Save and test”. Both free (ending in `:fx`) and paid keys work — the extension picks the matching endpoint automatically.'),
      },
    ],
    tips: [
      L('2026 年起 DeepL 不再给新用户开每月 50 万的 API Free，新用户的 Developer 额度是一次性的，适合当精确档的补充，不适合当主力。', 'Since 2026 DeepL no longer gives new users the 500,000-a-month API Free plan; the Developer quota is one-time, so use it to supplement the accurate tier rather than as the main engine.'),
      L('报错 456：额度用完了；报错 403：密钥填错或已经停用。', 'Error 456: quota used up; error 403: wrong or deactivated key.'),
      L('扩展会从 DeepL 账户读取实际的额度上限和已用量，显示在「服务状态」里；Developer 的一次性额度显示为「总额度」，不会显示成每月。', 'The extension reads the actual limit and usage from your DeepL account and shows them under “Status”; the one-time Developer quota is shown as a total, not per month.'),
    ],
    links: [
      { label: L('DeepL API 套餐', 'DeepL API plans'), url: 'https://www.deepl.com/pro-api' },
      { label: L('我的 API 密钥', 'My API keys'), url: 'https://www.deepl.com/your-account/keys' },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    providerId: 'gemini',
    kind: 'llm',
    tagline: L('大模型翻译，理解上下文好；有免费档，但有频率限制。', 'LLM translation that understands context; has a free tier with rate limits.'),
    free: L('免费档按模型限制每分钟 / 每天的请求次数（以 AI Studio 里显示的为准）', 'The free tier limits requests per minute / per day by model (see AI Studio for the current numbers)'),
    needs: L('Google 账号，年满 18 岁；所在地区要在 Gemini API 支持范围内（中国大陆、香港不支持）', 'A Google account, 18 or older; you must be in a region where the Gemini API is available (not mainland China or Hong Kong)'),
    bestFor: L('精确档、长句和专业文章', 'Accurate tier, long sentences and technical articles'),
    region: L('欧洲、北美、日本等可用', 'Available in Europe, North America, Japan and more'),
    steps: [
      {
        title: L('打开 Google AI Studio', 'Open Google AI Studio'),
        body: L('打开 [Google AI Studio](https://aistudio.google.com/)，用 Google 账号登录，第一次会让你同意服务条款。', 'Open [Google AI Studio](https://aistudio.google.com/) and sign in with your Google account; accept the terms the first time.'),
      },
      {
        title: L('创建 API key', 'Create an API key'),
        body: L('左侧点 **Get API key**（或直接打开 [API keys 页面](https://aistudio.google.com/api-keys)），点 **Create API key**，选 **Create API key in new project**（自动新建一个 Google Cloud 项目）。复制生成的密钥，一般以 `AIza` 开头。', 'Click **Get API key** on the left (or open the [API keys page](https://aistudio.google.com/api-keys)), click **Create API key** and choose **Create API key in new project** (creates a Google Cloud project for you). Copy the key — it usually starts with `AIza`.'),
      },
      {
        title: L('选一个模型名', 'Pick a model name'),
        body: L('在 AI Studio 的模型下拉框里看现在可用、并且标着免费档可用的模型，例如 `gemini-2.5-flash` 这类 Flash 模型（名字会随版本更新，以 AI Studio 里显示的为准）。翻译用 Flash 就够，又快又省额度。', 'In AI Studio’s model dropdown, find a model that is available on the free tier, e.g. a Flash model like `gemini-2.5-flash` (names change between versions; go by what AI Studio shows). Flash is enough for translation — fast and light on quota.'),
      },
      {
        title: L('填进扩展并测试', 'Fill it in and test'),
        body: L('在下面填 **API key** 和 **模型名称**，点「保存并测试」。', 'Fill in **API key** and **模型名称** (model name) below and click “Save and test”.'),
      },
    ],
    tips: [
      L('报错 429：免费档的频率用完了，等一分钟或第二天再用；扩展会先换别的服务。', 'Error 429: the free-tier rate limit is used up — wait a minute or until tomorrow; the extension switches to another service meanwhile.'),
      L('Google 的条款：在欧洲经济区、瑞士、英国，免费档的数据也按付费档的方式处理（不拿去训练）；做给别人用的产品在这些地区只能用付费档。只给自己用时请自己读一下条款。', 'Google’s terms: in the EEA, Switzerland and the UK, free-tier data is handled like the paid tier (not used for training); products offered to others there must use the paid tier. For personal use, please read the terms yourself.'),
    ],
    links: [
      { label: 'Google AI Studio', url: 'https://aistudio.google.com/' },
      { label: L('Gemini API 条款', 'Gemini API terms'), url: 'https://ai.google.dev/gemini-api/terms' },
      { label: L('免费档的频率限制', 'Free-tier rate limits'), url: 'https://ai.google.dev/gemini-api/docs/rate-limits' },
    ],
  },
  {
    id: 'zhipu',
    name: L('智谱 BigModel', 'Zhipu BigModel'),
    preset: { url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', modelHint: L('免费模型，例如 glm-4-flash、glm-4.7-flash（以「免费模型」文档为准）', 'Free models such as glm-4-flash or glm-4.7-flash (see the “free models” docs)') },
    kind: 'llm',
    tagline: L('Flash 系列模型长期免费，国内直连，适合当免费的精确档。', 'The Flash models are free long-term and reachable directly in China — a good free accurate tier.'),
    free: L('Flash 系列免费（只限并发和频率）；新用户另有体验额度', 'Flash models are free (only concurrency and rate limited); new users also get trial credit'),
    needs: L('手机号注册 + 实名认证', 'Phone sign-up + real-name verification'),
    bestFor: L('中文用户的精确档', 'Accurate tier for Chinese users'),
    region: L('中国大陆服务；海外用户可以用国际站 z.ai', 'Service in mainland China; users abroad can use the international site z.ai'),
    steps: [
      {
        title: L('注册并实名', 'Sign up and verify'),
        body: L('打开 [智谱开放平台](https://bigmodel.cn/)，手机号注册登录，按提示完成个人实名认证（调用 API 需要）。', 'Open the [Zhipu open platform](https://bigmodel.cn/), sign up with a phone number and complete personal real-name verification as prompted (required for API calls).'),
      },
      {
        title: L('创建 API Key', 'Create an API Key'),
        body: L('右上角头像或控制台里进入 **API Keys**（[直达](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)），点 **添加新的 API Key**，起个名字，复制生成的密钥。', 'Open **API Keys** from the avatar menu or the console ([direct link](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)), click **添加新的 API Key** (add a new API key), name it and copy the key.'),
      },
      {
        title: L('选免费模型', 'Choose a free model'),
        body: L('打开官方的 [免费模型说明](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash)，确认现在免费的模型名（例如 `glm-4-flash`、`glm-4.7-flash`）。', 'Check the official [free model docs](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash) for the current free model names (e.g. `glm-4-flash`, `glm-4.7-flash`).'),
      },
      {
        title: L('一键添加并测试', 'Add and test in one click'),
        body: L('在下面粘贴 API Key、确认模型名，点「添加并测试」。扩展会新建一个「OpenAI 兼容接口」服务，接口地址已经填好：`https://open.bigmodel.cn/api/paas/v4`。', 'Paste the API Key below, confirm the model name and click “Add and test”. The extension creates an “OpenAI-compatible” service with the endpoint already filled in: `https://open.bigmodel.cn/api/paas/v4`.'),
      },
    ],
    tips: [L('海外注册的 z.ai 账号要用国际站地址 `https://api.z.ai/api/paas/v4`，两边的密钥不通用。', 'Accounts registered abroad on z.ai use the international endpoint `https://api.z.ai/api/paas/v4`; keys do not work across the two.')],
    links: [
      { label: L('智谱开放平台', 'Zhipu open platform'), url: 'https://bigmodel.cn/' },
      { label: L('OpenAI 兼容说明', 'OpenAI compatibility docs'), url: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction' },
    ],
  },
  {
    id: 'siliconflow',
    name: L('硅基流动', 'SiliconFlow'),
    preset: { url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B', modelHint: L('免费模型，例如 Qwen/Qwen3-8B（模型广场里标「免费」的，名字区分大小写）', 'Free models such as Qwen/Qwen3-8B (marked “免费” in the model square; names are case-sensitive)') },
    kind: 'llm',
    tagline: L('一个密钥用很多开源模型，有免费的小模型。', 'One key for many open-source models, including free small ones.'),
    free: L('部分小模型免费（模型广场里标着「免费」）；实名后另有代金券', 'Some small models are free (marked “免费” in the model square); vouchers after real-name verification'),
    needs: L('中国大陆手机号 + 实名认证（支付宝人脸核验）', 'A mainland China phone number + real-name verification (Alipay face check)'),
    bestFor: L('国内用户的精确档、想试不同模型', 'Accurate tier for users in China, trying different models'),
    region: L('中国大陆服务', 'Service in mainland China'),
    steps: [
      {
        title: L('注册并实名', 'Sign up and verify'),
        body: L('打开 [硅基流动](https://cloud.siliconflow.cn/)，手机号 + 验证码注册。第一次进入会提示「当前账户未进行实名认证」，点 **立即认证 → 个人认证**，填姓名和身份证号，用支付宝扫码做人脸核验。不认证调用不了模型。', 'Open [SiliconFlow](https://cloud.siliconflow.cn/) and sign up with phone + code. On first entry it says the account is not verified: click **立即认证 → 个人认证** (verify now → personal), enter your name and ID number and do the face check by scanning with Alipay. Models cannot be called without verification.'),
      },
      {
        title: L('创建 API 密钥', 'Create an API key'),
        body: L('左侧菜单 **账户管理 → API 密钥**（[直达](https://cloud.siliconflow.cn/account/ak)），点 **新建 API 密钥**，复制以 `sk-` 开头的密钥。', 'In the left menu open **账户管理 → API 密钥** (account → API keys, [direct link](https://cloud.siliconflow.cn/account/ak)), click **新建 API 密钥** (new API key) and copy the key starting with `sk-`.'),
      },
      {
        title: L('选一个免费模型', 'Choose a free model'),
        body: L('在 **模型广场** 里筛选「免费」，记下完整的模型 ID，例如 `Qwen/Qwen3-8B`（大小写要一致）。', 'In the **模型广场** (model square) filter by “免费” (free) and note the full model ID, e.g. `Qwen/Qwen3-8B` (case must match).'),
      },
      {
        title: L('一键添加并测试', 'Add and test in one click'),
        body: L('在下面粘贴密钥、确认模型名，点「添加并测试」。接口地址已经填好：`https://api.siliconflow.cn/v1`。', 'Paste the key below, confirm the model name and click “Add and test”. The endpoint is already filled in: `https://api.siliconflow.cn/v1`.'),
      },
    ],
    tips: [L('免费模型有并发限制，适合当精确档或备用；翻译量大时可以选便宜的收费模型。', 'Free models have concurrency limits — fine for the accurate tier or as a backup; for heavy use pick a cheap paid model.')],
    links: [
      { label: L('硅基流动控制台', 'SiliconFlow console'), url: 'https://cloud.siliconflow.cn/' },
      { label: L('官方文档', 'Docs'), url: 'https://docs.siliconflow.cn/' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    preset: { url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', modelHint: L('例如 deepseek-flash（以官方文档的模型列表为准）', 'e.g. deepseek-flash (see the model list in the official docs)') },
    kind: 'llm',
    tagline: L('便宜、质量好的大模型；没有免费额度，要先充值。', 'A cheap, high-quality LLM; no free quota, top up first.'),
    free: L('没有免费额度，按用量付费（价格很低，充 10 元能用很久）', 'No free quota, pay as you go (very cheap — a small top-up lasts a long time)'),
    needs: L('手机号或邮箱注册，充值', 'Phone or email sign-up, top-up'),
    bestFor: L('想要高质量精确档、愿意花一点钱', 'A high-quality accurate tier for a little money'),
    region: L('中国大陆可直连，海外也可用', 'Reachable from mainland China and abroad'),
    steps: [
      {
        title: L('注册并充值', 'Sign up and top up'),
        body: L('打开 [DeepSeek 开放平台](https://platform.deepseek.com/)，注册登录后在 **充值** 页面先充一点钱（余额为 0 时请求会被拒绝，返回 402）。', 'Open the [DeepSeek platform](https://platform.deepseek.com/), sign up and add some balance on the **充值** (top up) page first (requests are rejected with 402 when the balance is 0).'),
      },
      {
        title: L('创建 API key', 'Create an API key'),
        body: L('左侧 **API keys**，点 **创建 API key**，起个名字，复制密钥。**密钥只显示这一次**，关掉就看不到了，丢了重新建一个。', 'Click **API keys** on the left, then **创建 API key** (create API key), name it and copy the key. **The key is shown only once** — if you lose it, create a new one.'),
      },
      {
        title: L('一键添加并测试', 'Add and test in one click'),
        body: L('在下面粘贴密钥、确认模型名（官方文档里当前的名字，例如 `deepseek-flash`），点「添加并测试」。接口地址已经填好：`https://api.deepseek.com/v1`。', 'Paste the key below, confirm the model name (the current one from the official docs, e.g. `deepseek-flash`) and click “Add and test”. The endpoint is already filled in: `https://api.deepseek.com/v1`.'),
      },
    ],
    tips: [L('旧教程里的 `deepseek-chat` 已经下线，用现在文档里的模型名。', '`deepseek-chat` from older tutorials has been retired; use the model names in the current docs.')],
    links: [
      { label: L('DeepSeek 开放平台', 'DeepSeek platform'), url: 'https://platform.deepseek.com/' },
      { label: L('官方文档（模型和价格）', 'Docs (models and pricing)'), url: 'https://api-docs.deepseek.com/zh-cn/' },
    ],
  },
  {
    id: 'libretranslate',
    name: L('LibreTranslate（自己部署）', 'LibreTranslate (self-hosted)'),
    kind: 'self',
    tagline: L('开源机器翻译，装在自己电脑或局域网里，免费、离线、不限量。', 'Open-source machine translation on your own computer or LAN — free, offline, unlimited.'),
    free: L('完全免费、不限量（用自己的电脑算）', 'Completely free and unlimited (runs on your own computer)'),
    needs: L('会用命令行；Python 3 或 Docker', 'Comfortable with a terminal; Python 3 or Docker'),
    bestFor: L('不想注册任何账号、注重隐私', 'No accounts at all, privacy first'),
    region: L('不需要联网（第一次下载语言模型时需要）', 'Works offline (needs internet only to download the language models the first time)'),
    steps: [
      {
        title: L('安装', 'Install'),
        body: L('有 Python 3：打开终端运行 `pip install libretranslate`，然后运行 `libretranslate`。第一次启动会下载语言模型，要等一会儿。\n有 Docker：运行 `docker run -ti --rm -p 5000:5000 libretranslate/libretranslate`。', 'With Python 3: run `pip install libretranslate` in a terminal, then `libretranslate`. The first start downloads the language models, which takes a while.\nWith Docker: run `docker run -ti --rm -p 5000:5000 libretranslate/libretranslate`.'),
      },
      {
        title: L('确认能用', 'Check that it works'),
        body: L('浏览器打开 `http://127.0.0.1:5000`，能看到 LibreTranslate 的翻译页面就说明启动好了。', 'Open `http://127.0.0.1:5000` in the browser; if you see the LibreTranslate page, it is running.'),
      },
      {
        title: L('在扩展里添加', 'Add it to the extension'),
        body: L('在下面的地址里填 `http://127.0.0.1:5000`（装在局域网另一台电脑上就填那台电脑的地址，例如 `http://192.168.1.20:5000`），自己部署的一般不需要 API key，点「添加并测试」。也可以去 [翻译服务](#providers) → **添加服务** → **LibreTranslate** 添加。', 'Enter `http://127.0.0.1:5000` as the address below (if it runs on another computer in your LAN, use that computer’s address, e.g. `http://192.168.1.20:5000`); self-hosted servers usually need no API key. Click “Add and test”. You can also add it under [Services](#providers) → **Add service** → **LibreTranslate**.'),
      },
    ],
    tips: [L('质量比微软、DeepL 和大模型差一些，适合当离线备用。', 'Quality is a bit below Microsoft, DeepL and LLMs — good as an offline backup.'), L('只想装几种语言可以加参数 `--load-only en,zh,de`，启动更快、占的空间更少。', 'To install only a few languages, add `--load-only en,zh,de`: faster start, less disk space.')],
    links: [{ label: L('LibreTranslate 官方文档', 'LibreTranslate docs'), url: 'https://docs.libretranslate.com/' }],
  },
];

/** 本地模型部署：按显卡给出下载哪个文件。 */
export const LLAMA_BUILDS = {
  version: 'b12069',
  release: 'https://github.com/ggml-org/llama.cpp/releases/tag/b12069',
  nvidia: ['llama-b12069-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip'],
  nvidiaOld: ['llama-b12069-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
  vulkan: ['llama-b12069-bin-win-vulkan-x64.zip'],
  cpu: ['llama-b12069-bin-win-cpu-x64.zip'],
};

export const MODEL_FILE = {
  name: 'Hy-MT2-1.8B-Q4_K_M.gguf',
  size: '1.13 GB',
  page: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF',
  url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf',
  mirror: 'https://hf-mirror.com/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf',
  sha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
};

/** 把教程正文的简单标记转成 DOM（只认 `代码`、**加粗**、[文字](链接)、以「- 」开头的列表行）。 */
export function renderRich(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split('\n');
  let list: HTMLUListElement | null = null;
  for (const line of lines) {
    const item = /^- (.*)$/.exec(line);
    const target: HTMLElement = item
      ? (list ??= frag.appendChild(document.createElement('ul'))).appendChild(document.createElement('li'))
      : frag.appendChild(document.createElement('p'));
    if (!item) list = null;
    inline(target, item ? item[1] : line);
  }
  return frag;
}

function inline(el: HTMLElement, text: string) {
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) el.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const c = document.createElement('code');
      c.textContent = m[1];
      el.append(c);
    } else if (m[2] !== undefined) {
      const b = document.createElement('b');
      b.textContent = m[2];
      el.append(b);
    } else {
      const a = document.createElement('a');
      a.textContent = m[3];
      const href = m[4];
      // 只允许 https 链接和设置页内部的 #锚点
      if (/^https:\/\//.test(href) || /^#[\w/-]+$/.test(href)) a.href = href;
      if (href.startsWith('https://')) {
        a.target = '_blank';
        a.rel = 'noopener';
      }
      el.append(a);
    }
  }
  if (last < text.length) el.append(text.slice(last));
}
