/**
 * 每日简讯自动抓取脚本
 * ------------------------------------------------------------
 * 这个脚本做两件事：
 *   1. 调用 Anthropic API（带网页搜索工具），让 Claude 实时搜索并整理
 *      五个类目的新闻，输出结构化 JSON。
 *   2. 调用 YouTube Data API v3，拿到你关注的几个频道最新一条视频。
 * 最后把两部分结果拼成 data.json，写到项目根目录，供 index.html 读取。
 *
 * 运行方式：
 *   ANTHROPIC_API_KEY=xxx YOUTUBE_API_KEY=xxx node scripts/fetch-briefing.mjs
 *
 * 在 GitHub Actions 里，这两个环境变量从仓库的 Secrets 注入
 * （见 .github/workflows/daily-briefing.yml）。
 * ------------------------------------------------------------
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const MODEL = process.env.BRIEFING_MODEL || "claude-sonnet-4-6";

if (!ANTHROPIC_API_KEY) {
  console.error("缺少环境变量 ANTHROPIC_API_KEY，无法调用新闻搜索，脚本退出。");
  process.exit(1);
}

// ---------------------------------------------------------------
// 配置区：五个新闻类目 + 你关注的 YouTube 频道
// 后续想增删类目、调整每类条数、换关注的频道，改这里就行。
// ---------------------------------------------------------------

const CATEGORIES = [
  {
    id: "ai",
    name: "AI 最新信息",
    count: 5,
    hint: "全球 AI 行业动态：新模型发布、芯片与算力、重要公司动作、监管政策等。",
  },
  {
    id: "github",
    name: "GitHub / 开源项目",
    count: 5,
    hint: "GitHub Trending、近期热门开源项目，优先选有实际工程价值、和 AI/开发者工具相关的项目。",
  },
  {
    id: "finance",
    name: "金融新闻",
    count: 5,
    hint: "全球及中国财经新闻：股市、宏观经济数据、重要公司财报或动作、大宗商品等。",
  },
  {
    id: "china",
    name: "中国新闻",
    count: 5,
    hint: "中国国内时政、经济、社会、科技、外交新闻。保持客观陈述事实，不带立场地呈现各方表态。",
  },
  {
    id: "world",
    name: "世界新闻",
    count: 5,
    hint: "国际重大新闻：地缘政治、自然灾害、重要选举或人事变动、跨国经济事件等。",
  },
];

// 频道 ID 已经帮你查好了；以后想加新关注的频道，去频道主页地址栏
// 或用 https://www.youtube.com/@handle 之后查看页源里的 channelId 即可。
const YOUTUBE_CHANNELS = [
  { channel: "老周横眉", channelId: "UCFDMMIHbtRdrVhHlGXVzApA" },
  { channel: "文昭思绪飞扬", channelId: "UCTu_hTaVf3DJMpMIyOAq2Ew" },
  { channel: "夸克说", channelId: "UCJj75G0tMMiUpG8h3-Yg0WQ" },
  { channel: "May Fit", channelId: "UCxGeKqFaKqpzkuFNGCFjcuA" },
  { channel: "盈夏AI轻创业", channelId: "UC9y_dhqHFtMYQx8jfZqZCvA" },
  { channel: "李厂长来了", channelId: "UC0v9b0Z00wWED_vGy-Q6ibg" },
];

const today = new Date();
const todayStr = today.toISOString().slice(0, 10);

// ---------------------------------------------------------------
// 调用 Anthropic API
// ---------------------------------------------------------------

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API 请求失败 (${res.status}): ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  return textBlocks.join("\n");
}

/** 从模型输出里粗暴地抠出第一个 JSON 数组或对象（防止模型多说了几句话）。 */
function extractJson(text) {
  const trimmed = text.trim();
  const arrStart = trimmed.indexOf("[");
  const objStart = trimmed.indexOf("{");
  let start = -1;
  let isArray = false;
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    start = arrStart;
    isArray = true;
  } else {
    start = objStart;
  }
  if (start === -1) throw new Error("输出里没有找到 JSON：" + trimmed.slice(0, 300));
  const end = isArray ? trimmed.lastIndexOf("]") : trimmed.lastIndexOf("}");
  const jsonStr = trimmed.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

async function fetchCategory(cat) {
  const prompt = `你是一个严谨的中文新闻编辑。今天是 ${todayStr}。
请使用网络搜索工具，查找今天及最近 1-2 天内关于"${cat.name}"的真实新闻，从中挑选最重要的 ${cat.count} 条。

类目方向参考：${cat.hint}

对每条新闻，给出以下字段：
- date：YYYY-MM-DD 格式，新闻发生或报道的日期，尽量准确，找不到精确日期就用你能确认的最接近日期
- title：中文标题，不超过 30 个字
- summary：80-120 字中文摘要，必须用你自己的话改写，不能逐字复制原文或大段抄录
- source：来源媒体或机构名称
- importance：可选，一句话说明这条新闻为什么重要（30字以内），如果这条新闻本身已经足够清楚不需要额外解释，可以省略这个字段

只输出一个 JSON 数组，格式如下，不要输出任何其他文字、不要用 markdown 代码块包裹：
[{"date":"2026-06-29","title":"...","summary":"...","source":"...","importance":"..."}, ...]`;

  const raw = await callClaude(prompt);
  const items = extractJson(raw);
  return { id: cat.id, name: cat.name, items };
}

async function fetchFocus(categories) {
  const headlineDigest = categories
    .map((c) => `【${c.name}】` + c.items.map((it) => it.title).join("；"))
    .join("\n");

  const prompt = `今天是 ${todayStr}。下面是今天简讯里五个类目的全部标题：
${headlineDigest}

请你写一段"今日焦点"，把其中最值得连起来看的几条新闻串成一段有洞察力的中文综述。
输出一个 JSON 对象，格式：
{"title":"一句话标题，30字以内，概括今天最重要的连接性主题","body":"150-220字的综述正文，用你自己的话写，把几条关键新闻有机地串起来，不要逐条复述"}
只输出这个 JSON 对象，不要任何其他文字，不要 markdown 代码块。`;

  const raw = await callClaude(prompt);
  return extractJson(raw);
}

// ---------------------------------------------------------------
// 调用 YouTube Data API v3
// ---------------------------------------------------------------

async function fetchYoutubeChannel(entry) {
  if (!YOUTUBE_API_KEY) {
    return {
      channel: entry.channel,
      desc: "（未配置 YOUTUBE_API_KEY，无法获取最新视频）",
      video: "请在仓库 Secrets 里添加 YOUTUBE_API_KEY 后重新运行",
      date: "",
    };
  }
  // 频道的"所有上传视频"播放列表 ID，把 channelId 的 UC 前缀换成 UU 即可，
  // 这样查询只消耗 1 个 quota 单位，比 search.list（100 单位）便宜得多。
  const uploadsPlaylistId = "UU" + entry.channelId.slice(2);
  const url =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=snippet&maxResults=1&playlistId=${uploadsPlaylistId}&key=${YOUTUBE_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const item = data.items && data.items[0];
    if (!item) {
      return {
        channel: entry.channel,
        desc: "未能获取到该频道的最新视频（频道可能设为私密或暂无公开视频）。",
        video: "",
        date: "",
      };
    }
    const publishedDate = (item.snippet.publishedAt || "").slice(0, 10);
    return {
      channel: entry.channel,
      desc: (item.snippet.description || "").slice(0, 80).replace(/\n/g, " "),
      video: item.snippet.title,
      date: publishedDate,
      url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
    };
  } catch (err) {
    return {
      channel: entry.channel,
      desc: "获取最新视频时出错：" + String(err).slice(0, 100),
      video: "",
      date: "",
    };
  }
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------

async function main() {
  console.log(`[${todayStr}] 开始抓取每日简讯…`);

  console.log("正在抓取五个新闻类目…");
  const categories = [];
  for (const cat of CATEGORIES) {
    console.log(` - ${cat.name}`);
    try {
      const result = await fetchCategory(cat);
      categories.push(result);
    } catch (err) {
      console.error(`   !! ${cat.name} 抓取失败：`, err.message);
      // 某一类失败不要让整个脚本中断，留空数组，页面会正常显示"0条"
      categories.push({ id: cat.id, name: cat.name, items: [] });
    }
  }

  console.log("正在生成今日焦点摘要…");
  let focus;
  try {
    focus = await fetchFocus(categories);
  } catch (err) {
    console.error("   !! 焦点摘要生成失败：", err.message);
    focus = { title: "今日焦点暂未生成", body: "焦点摘要生成失败，请查看各类目的具体新闻。" };
  }

  console.log("正在获取 YouTube 频道最新视频…");
  const youtube = [];
  for (const entry of YOUTUBE_CHANNELS) {
    console.log(` - ${entry.channel}`);
    youtube.push(await fetchYoutubeChannel(entry));
  }

  const data = {
    issueDate: todayStr,
    generatedAt: new Date().toISOString(),
    focus,
    categories,
    youtube,
  };

  const outPath = path.join(ROOT, "data.json");
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`写入完成：${outPath}`);
}

main().catch((err) => {
  console.error("脚本执行失败：", err);
  process.exit(1);
});
