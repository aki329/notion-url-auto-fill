import { Client, APIErrorCode, isNotionClientError } from "@notionhq/client";
import dotenv from "dotenv";
import * as cheerio from "cheerio";

dotenv.config();

type ProcessStatus = "pending" | "done" | "error" | "retry";

type PageCandidate = {
  id: string;
  url: string;
  currentStatus?: string;
  existingTitle?: string;
  existingCanonicalUrl?: string;
  errorNotePropertyName: "Error Note" | "メモ";
  statusType?: "status" | "select";
};

type ExtractedArticle = {
  title: string;
  summaryJa: string;
  metaDescription?: string;
  ogpImage?: string;
  siteName?: string;
  author?: string;
  publishedDate?: string;
  category: string;
  tags: string[];
  sourceType: "note" | "blog" | "news" | "other";
  canonicalUrl: string;
  domain: string;
};

type AppConfig = {
  notionToken: string;
  notionDatabaseId: string;
  requestTimeoutMs: number;
  userAgent: string;
  maxPagesPerRun: number;
};

type ProcessError = {
  type: string;
  message: string;
  url: string;
  step: string;
};

const NOTION_PROPS = {
  title: "記事タイトル",
  url: "URL",
  summary: "導入要約",
  publishedDate: "公開日",
  status: "ステータス",
  lastProcessedAt: "Last Processed At",
  memo: "メモ",
  legacyErrorNote: "Error Note",
  canonicalUrl: "Canonical URL",
} as const;

function loadConfig(): AppConfig {
  const notionToken = process.env.NOTION_TOKEN;
  const notionDatabaseId = process.env.NOTION_DATABASE_ID;

  if (!notionToken || !notionDatabaseId) {
    throw new Error("NOTION_TOKEN と NOTION_DATABASE_ID は必須です。.env を確認してください。");
  }

  return {
    notionToken,
    notionDatabaseId,
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 15000),
    userAgent: process.env.USER_AGENT ?? "notion-url-auto-fill-bot/1.0",
    maxPagesPerRun: Number(process.env.MAX_PAGES_PER_RUN ?? 20),
  };
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getDomainFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseDateToIso(raw?: string): string | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function textOrEmpty(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimToRange(text: string, min = 120, max = 180): string {
  const normalized = compactText(text);
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;

  const chunk = normalized.slice(0, max);
  const sentenceCut = Math.max(chunk.lastIndexOf("。"), chunk.lastIndexOf("."));
  if (sentenceCut >= min) return chunk.slice(0, sentenceCut + 1);

  return `${chunk.slice(0, max - 1)}…`;
}

function generateJapaneseSummary(input: {
  title: string;
  description?: string;
  bodyText?: string;
  headings: string[];
}): string {
  const source = [input.description, input.bodyText, input.headings.join(" / ")]
    .map((s) => compactText(s ?? ""))
    .filter(Boolean)
    .join(" ");

  const fallback = `${input.title}についての内容を整理した記事。要点を短く把握できるよう、概要と重要ポイントを確認しやすい形でまとめています。`;

  const base = source || fallback;
  const summary = `${input.title}に関する記事です。${base}`;
  return trimToRange(summary, 120, 180);
}

function inferSourceType(domain: string): "note" | "blog" | "news" | "other" {
  if (domain.includes("note.com")) return "note";
  if (["nikkei.com", "asahi.com", "mainichi.jp", "yahoo.co.jp"].some((d) => domain.includes(d))) return "news";
  if (domain.includes("blog") || domain.includes("hatenablog") || domain.includes("wordpress")) return "blog";
  return "other";
}

function inferCategory(title: string, text: string): string {
  const rules: Record<string, string[]> = {
    恋愛: ["恋愛", "彼氏", "彼女", "結婚", "失恋"],
    人間関係: ["人間関係", "コミュニケーション", "友人", "家族", "対人"],
    心理: ["心理", "メンタル", "感情", "自己肯定", "思考"],
    仕事: ["仕事", "転職", "キャリア", "副業", "組織"],
    エッセイ: ["エッセイ", "日記", "体験談", "振り返り"],
    note運用: ["note", "有料記事", "フォロワー", "運用"],
    SNS: ["SNS", "X", "Instagram", "TikTok", "投稿"],
    ライティング: ["文章", "執筆", "ライティング", "構成", "コピー"],
    マーケティング: ["マーケティング", "集客", "SEO", "導線", "CVR"],
  };

  const haystack = `${title} ${text}`.toLowerCase();
  for (const [category, keywords] of Object.entries(rules)) {
    if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      return category;
    }
  }
  return "その他";
}

function inferTags(title: string, body: string): string[] {
  const dictionary = [
    "note",
    "SEO",
    "マーケティング",
    "ライティング",
    "SNS",
    "恋愛",
    "心理",
    "仕事",
    "生産性",
    "キャリア",
    "ブランディング",
    "コンテンツ",
    "学習",
    "習慣",
    "思考",
  ];

  const corpus = `${title} ${body}`.toLowerCase();
  const matched = dictionary.filter((word) => corpus.includes(word.toLowerCase()));

  if (matched.length >= 3) return matched.slice(0, 5);

  // シンプルな形態素代替: 2文字以上の頻出語を拾う
  const words = corpus
    .replace(/[^\p{L}\p{N}ぁ-んァ-ヴー一-龠]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  const freq = new Map<string, number>();
  for (const word of words) {
    if (["https", "http", "com", "html", "note"].includes(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  const extra = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .slice(0, 5);

  return [...new Set([...matched, ...extra])].slice(0, 5);
}

function extractJsonLd($: cheerio.CheerioAPI): unknown[] {
  const jsonLdItems: unknown[] = [];
  $("script[type='application/ld+json']").each((_, el) => {
    const text = $(el).contents().text().trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        jsonLdItems.push(...parsed);
      } else {
        jsonLdItems.push(parsed);
      }
    } catch {
      // JSON-LDが壊れていても無視して継続
    }
  });
  return jsonLdItems;
}

function getMetaContent($: cheerio.CheerioAPI, key: string): string | undefined {
  const byProperty = $(`meta[property='${key}']`).attr("content");
  const byName = $(`meta[name='${key}']`).attr("content");
  return textOrEmpty(byProperty ?? byName) || undefined;
}

function extractArticleData(rawUrl: string, html: string): ExtractedArticle {
  const $ = cheerio.load(html);
  const jsonLd = extractJsonLd($);

  const title =
    getMetaContent($, "og:title") ??
    getMetaContent($, "twitter:title") ??
    textOrEmpty($("title").first().text()) ??
    textOrEmpty($("h1").first().text()) ??
    "(タイトル未取得)";

  const metaDescription = getMetaContent($, "og:description") ?? getMetaContent($, "description");

  const ogpImage =
    getMetaContent($, "og:image") ??
    getMetaContent($, "twitter:image") ??
    jsonLd
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const image = (item as Record<string, unknown>).image;
        if (typeof image === "string") return image;
        if (Array.isArray(image)) return image.find((v) => typeof v === "string") as string | undefined;
        if (image && typeof image === "object") {
          const url = (image as Record<string, unknown>).url;
          return typeof url === "string" ? url : undefined;
        }
        return undefined;
      })
      .find(Boolean);

  const domain = getDomainFromUrl(rawUrl);
  const siteName = getMetaContent($, "og:site_name") ?? domain;

  const author =
    getMetaContent($, "article:author") ??
    getMetaContent($, "author") ??
    jsonLd
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const value = (item as Record<string, unknown>).author;
        if (typeof value === "string") return value;
        if (value && typeof value === "object") {
          const name = (value as Record<string, unknown>).name;
          return typeof name === "string" ? name : undefined;
        }
        return undefined;
      })
      .find(Boolean);

  const publishedDate =
    parseDateToIso(getMetaContent($, "article:published_time")) ??
    parseDateToIso(getMetaContent($, "datePublished")) ??
    parseDateToIso($("time").first().attr("datetime")) ??
    jsonLd
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        return parseDateToIso((item as Record<string, string>).datePublished);
      })
      .find(Boolean);

  const canonicalUrl = textOrEmpty($("link[rel='canonical']").attr("href") ?? "") || rawUrl;

  const headingTexts = ["h1", "h2", "h3"]
    .flatMap((selector) => $(selector).toArray().slice(0, 5).map((el) => textOrEmpty($(el).text())))
    .filter(Boolean);

  const bodyText = compactText(
    [
      $("article").text(),
      $("main").text(),
      $("body").text(),
    ]
      .filter(Boolean)
      .join(" "),
  );

  const summaryJa = generateJapaneseSummary({
    title,
    description: metaDescription,
    bodyText,
    headings: headingTexts,
  });

  const category = inferCategory(title, `${metaDescription ?? ""} ${bodyText}`);
  const tags = inferTags(title, `${metaDescription ?? ""} ${bodyText}`);

  return {
    title,
    summaryJa,
    metaDescription,
    ogpImage,
    siteName,
    author,
    publishedDate,
    category,
    tags,
    sourceType: inferSourceType(domain),
    canonicalUrl,
    domain,
  };
}

async function fetchHtml(url: string, config: AppConfig): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": config.userAgent,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP_ERROR_${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error(`UNSUPPORTED_CONTENT_TYPE: ${contentType}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function toProcessError(error: unknown, url: string, step: string): ProcessError {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return { type: "timeout", message: "request timeout", url, step };
    }
    if (error.message.startsWith("HTTP_ERROR_")) {
      return { type: "http", message: error.message, url, step };
    }
    if (error.message.startsWith("UNSUPPORTED_CONTENT_TYPE")) {
      return { type: "content", message: error.message, url, step };
    }
    return { type: "unknown", message: error.message, url, step };
  }
  return { type: "unknown", message: String(error), url, step };
}

function processErrorToNote(err: ProcessError): string {
  return `type=${err.type}; step=${err.step}; message=${err.message}; url=${err.url}`;
}

function getTitleFromPage(page: Record<string, any>, propertyName: string): string | undefined {
  const prop = page.properties?.[propertyName];
  if (prop?.type !== "title") return undefined;
  return prop.title?.map((t: any) => t.plain_text).join("")?.trim();
}

function getRichText(page: Record<string, any>, propertyName: string): string | undefined {
  const prop = page.properties?.[propertyName];
  if (prop?.type !== "rich_text") return undefined;
  return prop.rich_text?.map((t: any) => t.plain_text).join("")?.trim();
}

function getUrlProp(page: Record<string, any>, propertyName: string): string | undefined {
  const prop = page.properties?.[propertyName];
  if (prop?.type !== "url") return undefined;
  return textOrEmpty(prop.url ?? "") || undefined;
}

function getStatus(page: Record<string, any>, propertyName: string): string | undefined {
  const prop = page.properties?.[propertyName];
  if (!prop) return undefined;

  if (prop.type === "status") return prop.status?.name;
  if (prop.type === "select") return prop.select?.name;
  return undefined;
}

function shouldSkipCandidate(page: PageCandidate): boolean {
  if (!page.url || !isValidHttpUrl(page.url)) return true;
  return page.currentStatus === "完了";
}

async function queryDatabasePages(notion: Client, config: AppConfig): Promise<PageCandidate[]> {
  const response = await notion.databases.query({
    database_id: config.notionDatabaseId,
    page_size: config.maxPagesPerRun,
    sorts: [
      {
        property: NOTION_PROPS.lastProcessedAt,
        direction: "ascending",
      },
    ],
  });

  const pages = response.results
    .filter((r): r is Record<string, any> => r.object === "page")
    .map((page) => ({
      id: page.id,
      url: getUrlProp(page, NOTION_PROPS.url) ?? "",
      currentStatus: getStatus(page, NOTION_PROPS.status),
      existingTitle: getTitleFromPage(page, NOTION_PROPS.title),
      existingCanonicalUrl: getUrlProp(page, NOTION_PROPS.canonicalUrl),
      errorNotePropertyName: page.properties?.[NOTION_PROPS.legacyErrorNote]
        ? NOTION_PROPS.legacyErrorNote
        : NOTION_PROPS.memo,
      statusType: page.properties?.[NOTION_PROPS.status]?.type,
    }));

  return pages.filter((page) => !shouldSkipCandidate(page));
}

async function buildCanonicalSet(notion: Client, config: AppConfig): Promise<Set<string>> {
  const response = await notion.databases.query({
    database_id: config.notionDatabaseId,
    page_size: 100,
  });

  const set = new Set<string>();
  for (const result of response.results) {
    if (result.object !== "page") continue;
    const page = result as Record<string, any>;
    const canonicalUrl = getUrlProp(page, NOTION_PROPS.canonicalUrl);
    const url = getUrlProp(page, NOTION_PROPS.url);
    const status = getStatus(page, NOTION_PROPS.status);

    // 完了データのみ重複判定に使う
    if (status !== "完了") continue;
    if (canonicalUrl) set.add(canonicalUrl);
    if (url) set.add(url);
  }
  return set;
}

function buildStatusUpdate(type: "status" | "select" | undefined, name: string): Record<string, unknown> {
  if (type === "select") {
    return { select: { name } };
  }
  return { status: { name } };
}

async function markPageError(
  notion: Client,
  pageId: string,
  error: ProcessError,
  page: Pick<PageCandidate, "errorNotePropertyName" | "statusType">,
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [NOTION_PROPS.status]: buildStatusUpdate(page.statusType, "エラー"),
      [page.errorNotePropertyName]: {
        rich_text: [{ type: "text", text: { content: processErrorToNote(error).slice(0, 1900) } }],
      },
      [NOTION_PROPS.lastProcessedAt]: {
        date: { start: new Date().toISOString() },
      },
    },
  });
}

async function updatePageSuccess(notion: Client, page: PageCandidate, data: ExtractedArticle): Promise<void> {
  const properties: Record<string, unknown> = {
    [NOTION_PROPS.summary]: {
      rich_text: [{ type: "text", text: { content: data.summaryJa.slice(0, 1900) } }],
    },
    [NOTION_PROPS.publishedDate]: data.publishedDate
      ? {
          date: { start: data.publishedDate },
        }
      : {
          date: null,
        },
    [NOTION_PROPS.status]: buildStatusUpdate(page.statusType, "完了"),
    [page.errorNotePropertyName]: {
      rich_text: [],
    },
    [NOTION_PROPS.lastProcessedAt]: {
      date: { start: new Date().toISOString() },
    },
  };

  if (!page.existingTitle) {
    properties[NOTION_PROPS.title] = {
      title: [{ type: "text", text: { content: data.title.slice(0, 200) } }],
    };
  }

  await notion.pages.update({
    page_id: page.id,
    properties,
  });
}

async function run(): Promise<void> {
  const config = loadConfig();
  const notion = new Client({ auth: config.notionToken });

  console.log("[START] Notion URL auto fill を開始します");

  const pages = await queryDatabasePages(notion, config);
  console.log(`[INFO] 処理候補: ${pages.length}件`);
  console.log(
    `[INFO] 使用プロパティ: title=${NOTION_PROPS.title}, url=${NOTION_PROPS.url}, summary=${NOTION_PROPS.summary}, publishedDate=${NOTION_PROPS.publishedDate}, status=${NOTION_PROPS.status}, lastProcessedAt=${NOTION_PROPS.lastProcessedAt}, memoFallback=${NOTION_PROPS.memo}`,
  );

  const doneUrlSet = await buildCanonicalSet(notion, config);

  for (const page of pages) {
    const url = page.url;
    console.log(`\n[PAGE] pageId=${page.id} url=${url}`);

    if (!isValidHttpUrl(url)) {
      const err: ProcessError = {
        type: "invalid_url",
        message: "URLが不正です",
        url,
        step: "validate_url",
      };
      console.log(`[WARN] ${processErrorToNote(err)}`);
      await markPageError(notion, page.id, err, page);
      console.log(`[RESULT] pageId=${page.id} status=エラー memoProp=${page.errorNotePropertyName}`);
      continue;
    }

    if (doneUrlSet.has(url) || (page.existingCanonicalUrl && doneUrlSet.has(page.existingCanonicalUrl))) {
      console.log("[SKIP] 既にdoneで同一URLが登録済みのためスキップ");
      continue;
    }

    try {
      const html = await fetchHtml(url, config);
      const extracted = extractArticleData(url, html);

      // 取得後のcanonicalで重複チェック
      if (doneUrlSet.has(extracted.canonicalUrl)) {
        console.log(`[SKIP] canonical重複: ${extracted.canonicalUrl}`);
        continue;
      }

      await updatePageSuccess(notion, page, extracted);
      doneUrlSet.add(url);
      doneUrlSet.add(extracted.canonicalUrl);
      console.log(
        `[RESULT] pageId=${page.id} status=完了 titleUpdated=${!page.existingTitle} summaryProp=${NOTION_PROPS.summary} publishedDateProp=${NOTION_PROPS.publishedDate} memoCleared=${page.errorNotePropertyName}`,
      );
    } catch (error) {
      const processError = toProcessError(error, url, "fetch_or_extract_or_update");
      console.log(`[ERROR] ${processErrorToNote(processError)}`);

      try {
        await markPageError(notion, page.id, processError, page);
        console.log(`[RESULT] pageId=${page.id} status=エラー memoProp=${page.errorNotePropertyName}`);
      } catch (notionUpdateError) {
        console.error("[FATAL] Notionへのエラー書き戻しにも失敗", notionUpdateError);
      }
    }
  }

  console.log("\n[FINISH] 処理が完了しました");
}

run().catch((error) => {
  if (isNotionClientError(error)) {
    if (error.code === APIErrorCode.ObjectNotFound) {
      console.error("[FATAL] Notionデータベースが見つかりません。DB共有設定とIDを確認してください。");
    } else {
      console.error(`[FATAL] Notion API エラー: ${error.code}`, error.message);
    }
  } else {
    console.error("[FATAL] 想定外エラー", error);
  }
  process.exit(1);
});
