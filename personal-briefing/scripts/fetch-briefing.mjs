/**
 * 每日简讯自动抓取脚本（RSS 免费版）
 * ------------------------------------------------------------
 * 这个版本完全免费，不调用任何按用量收费的 AI API。
 * 思路：
 *   1. AI / 金融 / 中国新闻 / 世界新闻 四个类目，直接从各家媒体公开提供的
 *      RSS 订阅源里抓取最新文章，取标题 + 媒体自带的摘要/简介，按时间排序
 *      取最新几条。不做 AI 改写，原文标题和摘要直接展示，并附上原文链接
 *      和媒体名称（保留来源署名）。
 *   2. GitHub 趋势项目：调用 GitHub 官方公开 API（无需 API Key），取最近
 *      被加星最多的仓库。
 *   3. YouTube 频道更新：调用 YouTube Data API v3（免费额度内）取每个
 *      关注频道的最新一条视频。这部分逻辑和之前一样，没有变化。
 *
 * 运行方式：
 *   YOUTUBE_API_KEY=xxx node scripts/fetch-briefing.mjs
 *   （如果暂时没有 YOUTUBE_API_KEY，脚本仍会正常跑完，只是 YouTube 那部分
 *    会显示"未配置"的提示，不会让整个脚本失败。）
 * ------------------------------------------------------------
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const today = new Date();
const todayStr = today.toISOString().slice(0, 10);

// ---------------------------------------------------------------
// 配置区：五个新闻类目对应的 RSS 源 + 你关注的 YouTube 频道
// 后续想换源、加源、调整每类条数，改这里就行。
// 每个类目可以配多个 RSS 源，脚本会把它们的文章混在一起，按时间排序后
// 取最新的 N 条。
// ---------------------------------------------------------------

const CATEGORIES = [
  {
    id: "ai",
    name: "AI 最新信息",
    count: 5,
    feeds: [
      { url: "https://techcrunch.com/category/artificial-intelligence/feed/", source: "TechCrunch" },
    ],
  },
  {
    id: "finance",
    name: "金融新闻",
    count: 5,
    feeds: [
      { url: "https://finance.yahoo.com/news/rssindex", source: "Yahoo Finance" },
      { url: "https://www.chinanews.com.cn/rss/finance.xml", source: "中国新闻网·财经" },
    ],
  },
  {
    id: "china",
    name: "中国新闻",
    count: 5,
    feeds: [
      { url: "https://www.chinanews.com.cn/rss/china.xml", source: "中国新闻网·时政" },
      { url: "https://www.chinanews.com.cn/rss/world.xml", source: "中国新闻网·国际" },
    ],
  },
  {
    id: "world",
    name: "世界新闻",
    count: 5,
    feeds: [
      { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC World" },
    ],
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

// ---------------------------------------------------------------
// 极简 RSS/Atom 解析器（不依赖第三方库，避免额外安装步骤）
// 只提取我们需要的字段：标题、链接、发布时间、摘要、来源
// ---------------------------------------------------------------

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function stripTags(html) {
  return decodeEntities(html)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : "";
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["'][^>]*/?>`, "i");
  const m = xml.match(re);
  return m ? m[1] : "";
}

/** 解析 RSS 2.0（<item>）或 Atom（<entry>）格式，统一输出同一种结构。 */
function parseFeed(xml, sourceName) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blockTag = isAtom ? "entry" : "item";
  const blockRe = new RegExp(`<${blockTag}[^>]*>([\\s\\S]*?)</${blockTag}>`, "gi");
  let match;
  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[1];
    const title = stripTags(extractTag(block, "title"));
    let link = "";
    if (isAtom) {
      link = extractAttr(block, "link", "href") || stripTags(extractTag(block, "link"));
    } else {
      link = stripTags(extractTag(block, "link"));
    }
    const pubDateRaw =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated") ||
      extractTag(block, "dc:date");
    const descRaw =
      extractTag(block, "description") ||
      extractTag(block, "summary") ||
      extractTag(block, "content");
    const summary = stripTags(descRaw).slice(0, 160);

    if (!title) continue;
    const date = pubDateRaw ? new Date(pubDateRaw) : null;
    items.push({
      title,
      link,
      summary: summary || "（该来源未提供摘要，请点击查看原文）",
      source: sourceName,
      date: date && !isNaN(date) ? date : null,
    });
  }
  return items;
}

async function fetchFeed(feedConfig) {
  try {
    const res = await fetch(feedConfig.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/rss+xml, application/xml, text/xml, */*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) {
      console.error(`   !! ${feedConfig.source} 请求失败：HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseFeed(xml, feedConfig.source);
  } catch (err) {
    console.error(`   !! ${feedConfig.source} 抓取出错：`, err.message);
    return [];
  }
}

async function fetchCategory(cat) {
  const allItems = [];
  for (const feed of cat.feeds) {
    const items = await fetchFeed(feed);
    allItems.push(...items);
  }
  // 按发布时间倒序排列（没有日期的排到最后），取前 N 条
  allItems.sort((a, b) => {
    if (a.date && b.date) return b.date - a.date;
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  const top = allItems.slice(0, cat.count).map((it) => ({
    date: it.date ? it.date.toISOString().slice(0, 10) : todayStr,
    title: it.title,
    summary: it.summary,
    source: it.source,
    url: it.link || undefined,
  }));
  return { id: cat.id, name: cat.name, items: top };
}

// ---------------------------------------------------------------
// 今日焦点：RSS 免费版不调用 AI，所以这里改成一个简单的自动拼装，
// 没有"洞察力综述"，而是直接把每个类目第一条新闻的标题罗列出来。
// 想要更有文采的焦点摘要，需要恢复用 AI（见 README 里"进阶选项"）。
// ---------------------------------------------------------------

function buildFocus(categories) {
  const lines = categories
    .filter((c) => c.items.length > 0)
    .map((c) => `【${c.name}】${c.items[0].title}`);
  return {
    title: `今日要览：${lines.length} 个类目共 ${categories.reduce((s, c) => s + c.items.length, 0)} 条更新`,
    body: lines.length
      ? lines.join("\n")
      : "今天暂未抓取到新内容，可能是 RSS 源临时不可用，请稍后查看或检查脚本日志。",
  };
}

// ---------------------------------------------------------------
// GitHub Trending（官方 API，免 Key）
// GitHub 没有官方"trending"接口，这里改用 Search API 按"最近一周内创建、
// star 数从高到低"排序，是社区常用的平替方案，同样完全免费、无需 Key。
// ---------------------------------------------------------------

async function fetchGithubTrending(count = 5) {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`created:>${since}`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${count}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) {
      console.error(`   !! GitHub Trending 请求失败：HTTP ${res.status}`);
      return { id: "github", name: "GitHub / 开源项目", items: [] };
    }
    const data = await res.json();
    const items = (data.items || []).map((repo) => ({
      date: "GitHub Trending",
      title: `${repo.full_name}（⭐ ${repo.stargazers_count}）`,
      summary: repo.description || "（该仓库未填写描述）",
      source: "GitHub",
      url: repo.html_url,
    }));
    return { id: "github", name: "GitHub / 开源项目", items };
  } catch (err) {
    console.error("   !! GitHub Trending 抓取出错：", err.message);
    return { id: "github", name: "GitHub / 开源项目", items: [] };
  }
}

// ---------------------------------------------------------------
// 调用 YouTube Data API v3（和之前版本一致，未改动）
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
  console.log(`[${todayStr}] 开始抓取每日简讯（RSS 免费版）…`);

  console.log("正在抓取四个 RSS 新闻类目…");
  const categories = [];
  for (const cat of CATEGORIES) {
    console.log(` - ${cat.name}`);
    try {
      categories.push(await fetchCategory(cat));
    } catch (err) {
      console.error(`   !! ${cat.name} 抓取失败：`, err.message);
      categories.push({ id: cat.id, name: cat.name, items: [] });
    }
  }

  console.log("正在抓取 GitHub 开源趋势…");
  categories.push(await fetchGithubTrending(5));

  console.log("正在生成今日焦点摘要（简单拼装版，不调用 AI）…");
  const focus = buildFocus(categories.filter((c) => c.id !== "github"));

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
