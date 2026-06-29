# 个人简讯 · 部署与自动化配置说明

这份文档教你怎么把这套东西部署到 GitHub Pages，并打开"每天东京时间早 8 点自动更新"的功能。

整套东西由三部分组成：

| 文件 | 作用 |
|---|---|
| `index.html` | 网页本身。打开时会先尝试读 `data.json`；读不到就用内置的示例数据兜底，所以**就算不配置自动化，网页也能正常打开看**。 |
| `scripts/fetch-briefing.mjs` | 抓取脚本。调用 Claude（带网页搜索）整理五类新闻，调用 YouTube API 拿频道最新视频，生成 `data.json`。 |
| `.github/workflows/daily-briefing.yml` | 定时任务配置。每天 UTC 23:00（= 东京时间次日早 8 点）自动跑一次抓取脚本，并把结果提交回仓库。 |

---

## 第一步：把代码放到 GitHub 上

1. 在 GitHub 上新建一个仓库（比如叫 `personal-briefing`），public 或 private 都行（如果用 private 仓库配 GitHub Pages，要确认你的 GitHub 套餐支持私有仓库的 Pages 功能）。
2. 把这次给你的所有文件（`index.html`、`scripts/` 文件夹、`.github/` 文件夹）放进这个仓库，提交、推送上去。

如果你本地没装 git，最简单的办法是：在 GitHub 仓库页面点 "Add file → Upload files"，把文件直接拖进去上传。

---

## 第二步：申请两个 API Key

这两个都不是你现在用的 Claude 聊天账号，是单独的开发者凭证。

### 1. Anthropic API Key（用于每天抓新闻）

1. 打开 [console.anthropic.com](https://console.anthropic.com)，用邮箱注册/登录（和 claude.ai 账号体系是分开的）。
2. 左侧找到 "API Keys"，创建一个新 Key，complete 后**马上复制保存好**（之后没法再看到完整内容）。
3. 这个账号需要绑定一张信用卡并预存一点余额（按 token 用量计费）。每天 6 次 API 调用（5 个类目 + 1 次焦点摘要），用的是 Sonnet 模型带网页搜索，正常情况下每天的花费大概是几美分到一两美元之间，具体取决于搜索结果的篇幅，可以先冲 5-10 美元观察头一两周的实际消耗。

### 2. YouTube Data API Key（用于拿频道最新视频，免费）

1. 打开 [console.cloud.google.com](https://console.cloud.google.com)，用你的 Google 账号登录，新建一个项目（名字随意）。
2. 左侧菜单找到 "API 和服务" → "库"，搜索 "YouTube Data API v3"，点击启用。
3. 左侧菜单 "API 和服务" → "凭据" → "创建凭据" → "API 密钥"，生成后复制保存。
4. 免费额度是每天 10,000 quota，我们这边一个频道只查 1 个 quota，6 个频道一天才 6 个 quota，完全够用，不会产生费用。

---

## 第三步：把两个 Key 加进 GitHub 仓库的 Secrets

1. 打开你的仓库页面 → Settings → Secrets and variables → Actions。
2. 点击 "New repository secret"，添加：
   - Name: `ANTHROPIC_API_KEY`，Value：刚才复制的 Anthropic key
   - 再加一个，Name: `YOUTUBE_API_KEY`，Value：刚才复制的 YouTube key

这两个值只有 GitHub Actions 在运行时能读到，不会出现在网页代码里，是安全的。

---

## 第四步：打开 GitHub Pages

1. 仓库 Settings → Pages。
2. Source 选 "Deploy from a branch"，Branch 选 `main`（或者你的默认分支），目录选 `/ (root)`。
3. 保存后等一两分钟，页面顶部会出现你的网址，形如 `https://你的用户名.github.io/仓库名/`。

---

## 第五步：手动跑一次，测试是否打通

不用等到明天早上 8 点才能看到效果：

1. 仓库页面顶部点 "Actions" 标签。
2. 左侧选 "每日简讯自动更新" 这个 workflow。
3. 右边点 "Run workflow" 手动触发一次。
4. 等个一两分钟，刷新页面能看到一次绿色的运行记录就说明成功了；如果是红色叉，点进去看日志，通常是 Key 填错了或者额度不够。
5. 成功后回到仓库看 `data.json` 文件，应该已经被自动更新、提交了一条新的 commit。
6. 打开你的 GitHub Pages 网址，应该能看到这次抓取到的真实内容。

---

## 之后呢？

- 每天 UTC 23:00（东京时间早 8 点）会自动跑一次，不用你管。
- 想调整时间、调整每类新闻条数、增删 YouTube 频道，改 `scripts/fetch-briefing.mjs` 顶部的配置区就行，改完推送到 GitHub 自动生效。
- 如果想加"真正推送到手机/邮箱"这一步（而不是只更新网页），告诉我，我可以在抓取脚本跑完之后加一段发邮件或者发到其他渠道的逻辑。
