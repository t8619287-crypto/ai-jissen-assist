// =====================================================
// AI実践アシスト 文章生成API(Cloudflare Worker)
//
// - OpenAI APIキーはこのWorkerのSecretにだけ保存されます
//   (フロントエンド・リポジトリには一切含まれません)
// - APP_ACCESS_TOKEN が一致するリクエストだけを受け付けます
//
// 必要な環境変数(SecretsまたはVariables):
//   OPENAI_API_KEY   … OpenAIのAPIキー(Secret)
//   APP_ACCESS_TOKEN … 自分で決めた合言葉(Secret)
//   OPENAI_MODEL     … 使うモデル(省略時は gpt-5.6-luna)
//   ALLOWED_ORIGIN   … 許可するサイト(カンマ区切り可)
//                      例: https://t8619287-crypto.github.io
// =====================================================

const DEFAULT_MODEL = "gpt-5.6-luna";

// コスト対策:1回の生成の出力上限(トークン)
const MAX_OUTPUT_TOKENS = { x: 1200, note: 4500 };

// リクエスト本文の上限(20KB)
const MAX_BODY_BYTES = 20 * 1024;

// OpenAI呼び出しのタイムアウト(ミリ秒)
const OPENAI_TIMEOUT_MS = 50000;

// 簡易レート制限:同じIPから10分間に30回まで
// (メモリ上のみの簡易版。サーバーが入れ替わるとリセットされる)
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };
const rateMap = new Map();

// 受け取る項目ごとの最大文字数
const FIELD_LIMITS = {
  date: 10,
  tools: 100,
  task: 200,
  time: 50,
  done: 600,
  fail: 600,
  learn: 600,
  income: 50,
  tomorrow: 300,
  extra: 500,
};

const STYLES = { standard: "自然なです・ます調", casual: "くだけた話し言葉", polite: "ていねいな敬体" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    // ブラウザの事前確認(preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Originヘッダーがあり、許可リストに無ければ拒否
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigins(env).includes(origin)) {
      return json({ error: "このサイトからの利用は許可されていません(Origin不一致)" }, 403, cors);
    }

    // アクセストークンの確認
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.APP_ACCESS_TOKEN || !timingSafeEqual(token, env.APP_ACCESS_TOKEN)) {
      return json(
        { error: "アクセストークンが正しくありません。アプリの「AI生成の設定」を確認してください" },
        401,
        cors
      );
    }

    // 簡易レート制限
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRate(ip)) {
      return json({ error: "リクエストが多すぎます。10分ほど待ってから試してください" }, 429, cors);
    }

    // 接続テスト用(秘密情報は返さない)
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, model: env.OPENAI_MODEL || DEFAULT_MODEL }, 200, cors);
    }

    // 文章生成
    if (url.pathname === "/api/generate" && request.method === "POST") {
      return handleGenerate(request, env, cors);
    }

    return json({ error: "エンドポイントが見つかりません" }, 404, cors);
  },
};

// -----------------------------------------------------
// 文章生成の本体
// -----------------------------------------------------
async function handleGenerate(request, env, cors) {
  // サイズ制限
  const length = Number(request.headers.get("Content-Length") || "0");
  if (length > MAX_BODY_BYTES) {
    return json({ error: "リクエストが大きすぎます" }, 413, cors);
  }

  // JSONとして読む
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "リクエストの形式が正しくありません" }, 400, cors);
  }

  // 入力検証
  const check = validateRequest(body);
  if (!check.ok) {
    return json({ error: check.reason }, 400, cors);
  }
  const { type, record, options } = check;

  // OpenAI Responses API を呼ぶ
  let aiResult;
  try {
    aiResult = await callOpenAI(env, type, record, options);
  } catch (e) {
    // タイムアウトや通信エラー(詳細やキーは返さない)
    if (e && e.name === "TimeoutError") {
      return json({ error: "生成がタイムアウトしました。もう一度試してください" }, 504, cors);
    }
    if (e && e.httpStatus === 401) {
      return json({ error: "サーバー側のOpenAI APIキー設定に問題があります(管理者向け:OPENAI_API_KEYを確認)" }, 502, cors);
    }
    if (e && e.httpStatus === 429) {
      return json({ error: "OpenAI側の利用上限に達したか混雑しています。時間を置いて試してください" }, 502, cors);
    }
    return json({ error: "AIの呼び出しに失敗しました。時間を置いて試してください" }, 502, cors);
  }

  return json(aiResult, 200, cors);
}

// -----------------------------------------------------
// 入力検証
// -----------------------------------------------------
function validateRequest(body) {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "リクエストの形式が正しくありません" };
  }
  const type = body.type;
  if (type !== "x" && type !== "note") {
    return { ok: false, reason: "生成種類は x または note を指定してください" };
  }

  const rawRecord = typeof body.record === "object" && body.record !== null ? body.record : {};
  const record = {};
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    if (field === "extra") continue;
    const value = rawRecord[field];
    if (value === undefined || value === null) {
      record[field] = "";
      continue;
    }
    if (typeof value !== "string") {
      return { ok: false, reason: `${field} は文字列で指定してください` };
    }
    if (Array.from(value).length > limit) {
      return { ok: false, reason: `${field} が長すぎます(最大${limit}文字)` };
    }
    record[field] = value.trim();
  }

  // 空データチェック:最低限「取り組んだ作業」は必要
  if (!record.task) {
    return { ok: false, reason: "取り組んだ作業(task)が空です。記録を選んでください" };
  }

  const rawOptions = typeof body.options === "object" && body.options !== null ? body.options : {};
  const style = STYLES[rawOptions.style] ? rawOptions.style : "standard";
  const hashtags = rawOptions.hashtags === true;
  let extra = "";
  if (rawOptions.extra !== undefined && rawOptions.extra !== null) {
    if (typeof rawOptions.extra !== "string") {
      return { ok: false, reason: "extra は文字列で指定してください" };
    }
    if (Array.from(rawOptions.extra).length > FIELD_LIMITS.extra) {
      return { ok: false, reason: `補足情報が長すぎます(最大${FIELD_LIMITS.extra}文字)` };
    }
    extra = rawOptions.extra.trim();
  }

  return { ok: true, type, record, options: { style, hashtags, extra } };
}

// -----------------------------------------------------
// OpenAI Responses API の呼び出し
// -----------------------------------------------------
async function callOpenAI(env, type, record, options) {
  const model = env.OPENAI_MODEL || DEFAULT_MODEL;
  const instructions = type === "x" ? xInstructions(options) : noteInstructions(options);
  const input = buildInput(type, record, options);
  const schema = type === "x" ? X_SCHEMA : NOTE_SCHEMA;

  const payload = {
    model: model,
    instructions: instructions,
    input: input,
    max_output_tokens: MAX_OUTPUT_TOKENS[type],
    // Web検索などの外部ツールは使わない(toolsを指定しない)
    text: {
      format: {
        type: "json_schema",
        name: type === "x" ? "x_posts" : "note_article",
        strict: true,
        schema: schema,
      },
    },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = new Error("openai_error");
    err.httpStatus = res.status;
    throw err;
  }

  const data = await res.json();
  const text = extractOutputText(data);
  if (!text) {
    const err = new Error("empty_output");
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error("bad_json");
    throw err;
  }

  // 返す前に形をそろえ、文字数も付ける
  if (type === "x") {
    const posts = (parsed.posts || []).slice(0, 3).map((p) => ({
      label: String(p.label || ""),
      text: String(p.text || ""),
      length: Array.from(String(p.text || "")).length,
    }));
    if (posts.length === 0) throw new Error("empty_posts");
    return { type: "x", posts };
  }

  return {
    type: "note",
    titles: (parsed.titles || []).slice(0, 3).map(String),
    recommendedTitle: String(parsed.recommendedTitle || ""),
    intro: String(parsed.intro || ""),
    sections: (parsed.sections || []).map((s) => ({
      heading: String(s.heading || ""),
      body: String(s.body || ""),
    })),
    summary: String(parsed.summary || ""),
    nextAction: String(parsed.nextAction || ""),
    hashtags: (parsed.hashtags || []).map(String),
  };
}

// Responses APIの返答から本文テキストを取り出す
function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  if (!Array.isArray(data.output)) return "";
  for (const item of data.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") return c.text;
      }
    }
  }
  return "";
}

// -----------------------------------------------------
// プロンプト(指示文)
// -----------------------------------------------------
function xInstructions(options) {
  return `あなたはAI副業の実践記録を日本語で発信するXユーザーです。
与えられた実践記録から、X投稿文を3案作成してください。

【全案共通の条件】
- 日本語で書く
- ハッシュタグを含めて、必ず140文字以内に収める
- 「収益 → 今日やったこと → 学び → 明日の行動」の順番で書く
- 記録に書かれていない成果・数字・経験を絶対に追加しない
- AI副業初心者の等身大の実践記録として自然な文章にする
- 過度に成功者らしく見せない。煽らない
- 3案で同じ表現を繰り返さない
- 文体:${STYLES[options.style]}
- ハッシュタグ:${options.hashtags ? "#AI副業 を含めて1〜2個付ける(それでも140文字以内厳守)" : "付けない"}

【3案の方向性】
1案目 label="素直な実践記録":事実を順番に淡々と
2案目 label="共感型":同じ初心者に共感されやすい一言を添える
3案目 label="短く読みやすい":できるだけ短く、テンポよく`;
}

function noteInstructions(options) {
  return `あなたはAI副業の実践記録を日本語で発信するnoteライターです。
与えられた実践記録から、note記事を1本作成してください。

【条件】
- 日本語で書く
- AI副業初心者の等身大の実践記録として書く
- 失敗や収益0円も隠さず、そのまま書く
- 記録に書かれていない経験・成果・数字を絶対に追加しない
- 記録の情報が少ない場合は、水増しせずに短い記事のままでよい
- 読みやすい短めの段落に分ける
- 「〜ではないでしょうか」の乱発など不自然なAI文章にしない
- 過剰な断定や煽りを避ける
- 全体の目安は1500〜2500文字(情報が少なければ短くてよい)
- 文体:${STYLES[options.style]}

【出力する内容】
- titles:目を引くタイトル案を3つ
- recommendedTitle:その中で最もおすすめのタイトル
- intro:導入文(記事の入り口。2〜4文)
- sections:見出し(heading)と本文(body)のセット。「実際にやったこと」「つまずいたこと」「学んだこと」など記録に沿って構成
- summary:まとめ
- nextAction:次に行うこと
- hashtags:noteに付けるおすすめハッシュタグ(3〜5個、#付き)`;
}

// AIに渡す記録データ(必要な項目だけ)
function buildInput(type, record, options) {
  const lines = [];
  if (type === "x") {
    lines.push("【実践記録】");
    lines.push(`・今日の収益:${record.income || "0円"}`);
    lines.push(`・今日やったこと:${record.task}${record.done ? "(" + record.done + ")" : ""}`);
    lines.push(`・学んだこと:${record.learn || "特になし"}`);
    lines.push(`・明日の行動:${record.tomorrow || "未定"}`);
  } else {
    lines.push("【実践記録】");
    lines.push(`・日付:${record.date || "未記入"}`);
    lines.push(`・使用したAIツール:${record.tools || "未記入"}`);
    lines.push(`・取り組んだ作業:${record.task}`);
    lines.push(`・作業時間:${record.time || "未記入"}`);
    lines.push(`・できたこと:${record.done || "未記入"}`);
    lines.push(`・失敗したこと:${record.fail || "未記入"}`);
    lines.push(`・学んだこと:${record.learn || "未記入"}`);
    lines.push(`・今日の収益:${record.income || "0円"}`);
    lines.push(`・明日やること:${record.tomorrow || "未記入"}`);
  }
  if (options.extra) {
    lines.push("【補足情報】");
    lines.push(options.extra);
  }
  return lines.join("\n");
}

// -----------------------------------------------------
// 構造化出力のスキーマ(返答を安定したJSONにする)
// -----------------------------------------------------
const X_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          text: { type: "string" },
        },
        required: ["label", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
};

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    titles: { type: "array", items: { type: "string" } },
    recommendedTitle: { type: "string" },
    intro: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          body: { type: "string" },
        },
        required: ["heading", "body"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
    nextAction: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["titles", "recommendedTitle", "intro", "sections", "summary", "nextAction", "hashtags"],
  additionalProperties: false,
};

// -----------------------------------------------------
// 補助関数
// -----------------------------------------------------
function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    // AI生成の返答をブラウザや中継サーバーにキャッシュさせない
    "Cache-Control": "no-store",
  };
  if (allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

// トークン比較(単純な === より推測攻撃に強い比較方法)
function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(String(a));
  const bufB = encoder.encode(String(b));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

function checkRate(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT.max;
}
