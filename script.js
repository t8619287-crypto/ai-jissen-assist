// =====================================================
// AI実践アシスト
// - 記録はブラウザの localStorage にだけ保存されます
// - 自動投稿・自動リプ・自動フォローの機能はありません
// =====================================================

// localStorage のキー(※以前のバージョンと同じ名前なので、過去の記録も引き継がれます)
const STORAGE_KEY = "aiSideJobRecords";
// プロンプト作成回数(note用・X投稿用)を数えるためのキー
const STATS_KEY = "aiSideJobStats";

// 履歴から「編集」中の記録のid(新規作成のときは null)
let editingRecordId = null;

// -----------------------------------------------------
// 便利関数
// -----------------------------------------------------
function $(id) {
  return document.getElementById(id);
}

function isoToday() {
  const t = new Date();
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${mm}-${dd}`;
}

// -----------------------------------------------------
// 保存データの読み書き
// -----------------------------------------------------
function loadRecords() {
  const json = localStorage.getItem(STORAGE_KEY);
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch (e) {
    console.error("保存データの読み込みに失敗しました", e);
    return [];
  }
}

function saveRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY)) || { notePrompts: 0, xPosts: 0 };
  } catch (e) {
    return { notePrompts: 0, xPosts: 0 };
  }
}

function saveStats(stats) {
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));
}

// -----------------------------------------------------
// トースト通知(画面下にふわっと出る通知)
// -----------------------------------------------------
let toastTimer = null;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
}

// -----------------------------------------------------
// 画面の切り替え(ホーム / 記録 / 発信 / 履歴)
// -----------------------------------------------------
function showScreen(name) {
  // すべての画面を隠して、選ばれた画面だけ表示する
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $("screen-" + name).classList.add("active");

  // 下部メニューの「現在地」を青く強調する
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === name);
  });

  // 画面ごとに最新の内容へ描き直す
  if (name === "home") renderHome();
  if (name === "history") renderHistory();
  if (name === "post") renderPostSelect();

  window.scrollTo(0, 0);
}

// -----------------------------------------------------
// 文字から数字を取り出す(統計用)
// -----------------------------------------------------

// 「500円」「1,200円」→ 500, 1200
function parseYen(str) {
  if (!str) return 0;
  const m = String(str).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

// 「2時間」「30分」「1時間30分」→ 2, 0.5, 1.5(時間)
function parseHoursText(str) {
  if (!str) return 0;
  const s = String(str);
  let hours = 0;
  const hm = s.match(/(\d+(?:\.\d+)?)\s*時間/);
  const mm = s.match(/(\d+(?:\.\d+)?)\s*分/);
  if (hm) hours += parseFloat(hm[1]);
  if (mm) hours += parseFloat(mm[1]) / 60;
  if (!hm && !mm) {
    // 「2」のように数字だけ書かれたら「時間」とみなす
    const n = s.match(/\d+(\.\d+)?/);
    if (n) hours = parseFloat(n[0]);
  }
  return hours;
}

// -----------------------------------------------------
// ① ホーム画面
// -----------------------------------------------------
function renderHome() {
  const records = loadRecords();
  const stats = loadStats();
  const today = isoToday();

  // 今日の収益(今日の日付の記録の収益を合計)
  const todayIncome = records
    .filter((r) => r.date === today)
    .reduce((sum, r) => sum + parseYen(r.income), 0);

  // 今週の作業時間(月曜はじまり)
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weekHours = records
    .filter((r) => {
      if (!r.date) return false;
      const d = new Date(r.date + "T00:00:00");
      return d >= monday && d <= now;
    })
    .reduce((sum, r) => sum + parseHoursText(r.time), 0);

  $("stat-income").textContent = todayIncome.toLocaleString() + "円";
  $("stat-hero-date").textContent = today.replace(/-/g, "/") + " 時点";
  $("stat-hours").textContent = Math.round(weekHours * 10) / 10 + "時間";
  $("stat-records").textContent = records.length + "件";
  $("stat-note").textContent = stats.notePrompts + "回";
  $("stat-x").textContent = stats.xPosts + "回";

  // 最近の活動(新しい順に3件)
  const area = $("recent-list");
  area.innerHTML = "";
  const recent = [...records].sort((a, b) => b.id - a.id).slice(0, 3);

  if (recent.length === 0) {
    area.innerHTML =
      '<p class="empty-message">まだ記録がありません。「+ 新しい実践を記録」から始めましょう。</p>';
    return;
  }

  for (const rec of recent) {
    const item = document.createElement("div");
    item.className = "recent-item";

    const date = document.createElement("p");
    date.className = "recent-date";
    date.textContent = rec.date;

    const task = document.createElement("p");
    task.className = "recent-task";
    task.textContent = rec.task;

    const meta = document.createElement("p");
    meta.className = "recent-meta";
    meta.textContent = `${rec.tools || "ツール未記入"} / ${rec.time || "時間未記入"} / 収益:${rec.income || "未記入"}`;

    item.appendChild(date);
    item.appendChild(task);
    item.appendChild(meta);
    area.appendChild(item);
  }
}

// -----------------------------------------------------
// ② 記録画面(保存・編集)
// -----------------------------------------------------
function clearForm() {
  editingRecordId = null;
  $("edit-banner").hidden = true;
  $("in-date").value = isoToday();
  ["in-tools", "in-task", "in-time", "in-done", "in-fail", "in-learn", "in-income", "in-tomorrow"]
    .forEach((id) => ($(id).value = ""));
}

function onSaveClick() {
  const record = {
    id: editingRecordId || Date.now(), // 編集中なら元のid、新規なら今の時刻
    date: $("in-date").value,
    tools: $("in-tools").value.trim(),
    task: $("in-task").value.trim(),
    time: $("in-time").value.trim(),
    done: $("in-done").value.trim(),
    fail: $("in-fail").value.trim(),
    learn: $("in-learn").value.trim(),
    income: $("in-income").value.trim(),
    tomorrow: $("in-tomorrow").value.trim(),
  };

  if (!record.date) {
    showToast("⚠ 日付を入力してください");
    return;
  }
  if (!record.task) {
    showToast("⚠ 取り組んだ作業を入力してください");
    return;
  }

  const records = loadRecords();

  if (editingRecordId) {
    // 編集モード:同じidの記録を置き換える
    const index = records.findIndex((r) => r.id === editingRecordId);
    if (index !== -1) {
      records[index] = record;
    } else {
      records.push(record);
    }
    saveRecords(records);
    clearForm();
    showToast("✔ 記録を更新しました");
    showScreen("history"); // 更新結果がすぐ見えるように履歴へ
  } else {
    // 新規保存
    records.push(record);
    saveRecords(records);
    clearForm();
    showToast("✔ 保存しました!");
  }
}

function startEdit(rec) {
  editingRecordId = rec.id;
  $("in-date").value = rec.date || "";
  $("in-tools").value = rec.tools || "";
  $("in-task").value = rec.task || "";
  $("in-time").value = rec.time || "";
  $("in-done").value = rec.done || "";
  $("in-fail").value = rec.fail || "";
  $("in-learn").value = rec.learn || "";
  $("in-income").value = rec.income || "";
  $("in-tomorrow").value = rec.tomorrow || "";
  $("edit-banner").hidden = false;
  $("edit-banner-text").textContent = `編集中:${rec.date}|${rec.task}`;
  showScreen("record");
}

// -----------------------------------------------------
// ④ 履歴画面(カード表示・詳細・編集・削除)
// -----------------------------------------------------
function renderHistory() {
  const listArea = $("record-list");
  const records = loadRecords();
  listArea.innerHTML = "";

  if (records.length === 0) {
    listArea.innerHTML =
      '<p class="empty-message">まだ記録がありません。「記録」タブから保存してみましょう。</p>';
    return;
  }

  const sorted = [...records].sort((a, b) => b.id - a.id);

  for (const rec of sorted) {
    const item = document.createElement("div");
    item.className = "record-item";

    const title = document.createElement("p");
    title.className = "record-title";
    title.textContent = `${rec.date}|${rec.task}`;

    const meta = document.createElement("p");
    meta.className = "record-meta";
    meta.textContent = `${rec.tools || "ツール未記入"} / ${rec.time || "時間未記入"} / 収益:${rec.income || "未記入"}`;

    // 詳細(最初は隠しておく)
    const detail = document.createElement("dl");
    detail.className = "record-detail";
    detail.hidden = true;
    const fields = [
      ["できたこと", rec.done],
      ["失敗したこと", rec.fail],
      ["学んだこと", rec.learn],
      ["明日やること", rec.tomorrow],
    ];
    for (const [label, value] of fields) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value || "未記入";
      detail.appendChild(dt);
      detail.appendChild(dd);
    }

    // 詳細ボタン
    const btnDetail = document.createElement("button");
    btnDetail.className = "btn btn-secondary btn-small";
    btnDetail.textContent = "詳細";
    btnDetail.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      btnDetail.textContent = detail.hidden ? "詳細" : "閉じる";
    });

    // 編集ボタン
    const btnEdit = document.createElement("button");
    btnEdit.className = "btn btn-secondary btn-small";
    btnEdit.textContent = "編集";
    btnEdit.addEventListener("click", () => startEdit(rec));

    // 削除ボタン(押し間違い防止のため、2回タップで削除する方式)
    const btnDelete = document.createElement("button");
    btnDelete.className = "btn btn-danger btn-small";
    btnDelete.textContent = "削除";
    let confirmTimer = null;
    btnDelete.addEventListener("click", () => {
      if (btnDelete.dataset.confirming !== "true") {
        // 1回目のタップ:確認モードにする(3秒たったら元に戻る)
        btnDelete.dataset.confirming = "true";
        btnDelete.textContent = "本当に削除?";
        confirmTimer = setTimeout(() => {
          btnDelete.dataset.confirming = "false";
          btnDelete.textContent = "削除";
        }, 3000);
        return;
      }
      // 2回目のタップ:実際に削除する
      clearTimeout(confirmTimer);
      saveRecords(loadRecords().filter((r) => r.id !== rec.id));
      if (editingRecordId === rec.id) clearForm();
      renderHistory();
      showToast("記録を削除しました");
    });

    const btnRow = document.createElement("div");
    btnRow.className = "record-btns";
    btnRow.appendChild(btnDetail);
    btnRow.appendChild(btnEdit);
    btnRow.appendChild(btnDelete);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(detail);
    item.appendChild(btnRow);
    listArea.appendChild(item);
  }
}

// -----------------------------------------------------
// ③ 発信画面(記録の選択・プロンプト生成)
// -----------------------------------------------------

// 記録を選ぶプルダウンを最新の状態にする
function renderPostSelect() {
  const select = $("post-record-select");
  const previous = select.value; // 選び直しにならないよう、前の選択を覚えておく
  select.innerHTML = "";

  const records = [...loadRecords()].sort((a, b) => b.id - a.id);

  if (records.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "記録がありません(先に「記録」タブで保存)";
    select.appendChild(opt);
    return;
  }

  for (const rec of records) {
    const opt = document.createElement("option");
    opt.value = String(rec.id);
    opt.textContent = `${rec.date}|${rec.task}`;
    select.appendChild(opt);
  }

  // 前に選んでいた記録がまだあればそれを、なければ最新を選ぶ
  if (previous && records.some((r) => String(r.id) === previous)) {
    select.value = previous;
  }
}

function getSelectedRecord() {
  const id = Number($("post-record-select").value);
  if (!id) return null;
  return loadRecords().find((r) => r.id === id) || null;
}

// note記事用プロンプト
function makeNotePrompt(rec) {
  return `あなたはAI副業について発信するnoteライターです。
以下の実践記録をもとに、読者の役に立つnote記事の下書きを書いてください。

【実践記録】
・日付:${rec.date}
・使用したAIツール:${rec.tools || "未記入"}
・取り組んだ作業:${rec.task}
・作業時間:${rec.time || "未記入"}
・できたこと:${rec.done || "未記入"}
・失敗したこと:${rec.fail || "未記入"}
・学んだこと:${rec.learn || "未記入"}
・今日の収益:${rec.income || "未記入"}
・明日やること:${rec.tomorrow || "未記入"}

【記事の条件】
・タイトル案を3つ出す
・構成は「導入 → 実際にやったこと → つまずいたポイント → 学び → まとめ」
・初心者にも分かる言葉で書く
・体験談として正直に書き、誇張した収益表現はしない
・文字数は1500〜2500字程度`;
}

// X投稿用プロンプト(収益 → 今日やったこと → 学び → 明日の行動 の順)
function makePostPrompt(rec) {
  return `あなたはAI副業の実践記録を発信するX(旧Twitter)ユーザーです。
以下の記録をもとに、X投稿文を1つ作ってください。

【記録】
・今日の収益:${rec.income || "未記入"}
・今日やったこと:${rec.task}${rec.done ? "(" + rec.done + ")" : ""}
・学んだこと:${rec.learn || "未記入"}
・明日の行動:${rec.tomorrow || "未記入"}

【投稿文の条件】
・「収益 → 今日やったこと → 学び → 明日の行動」の順番で書く
・全体で140文字以内に収める
・誇張せず、等身大の実践記録として書く
・絵文字は1〜3個まで
・ハッシュタグは #AI副業 を含めて2個まで`;
}

function onNotePromptClick() {
  const rec = getSelectedRecord();
  if (!rec) {
    showToast("⚠ 先に「記録」タブで実践を保存してください");
    return;
  }
  $("prompt-output").value = makeNotePrompt(rec);
  const stats = loadStats();
  stats.notePrompts += 1;
  saveStats(stats);
  showToast("✔ note記事用プロンプトを作成しました");
}

function onPostPromptClick() {
  const rec = getSelectedRecord();
  if (!rec) {
    showToast("⚠ 先に「記録」タブで実践を保存してください");
    return;
  }
  $("prompt-output").value = makePostPrompt(rec);
  const stats = loadStats();
  stats.xPosts += 1;
  saveStats(stats);
  showToast("✔ X投稿用プロンプトを作成しました");
}

function onReplyPromptClick() {
  const targetPost = $("reply-input").value.trim();
  if (!targetPost) {
    showToast("⚠ 相手の投稿本文を貼り付けてください");
    return;
  }
  $("reply-output").value = `あなたはAI副業について発信しているXユーザーです。
以下の投稿に対する、自然で感じの良い返信案を3つ作ってください。

【相手の投稿】
${targetPost}

【返信の条件】
・相手の内容にきちんと触れて、共感や具体的な感想を伝える
・宣伝や売り込みはしない
・上から目線にならない
・それぞれ80文字以内
・絵文字は0〜1個`;
  showToast("✔ 返信用プロンプトを作成しました");
}

// -----------------------------------------------------
// データのバックアップ(書き出し・復元)
// -----------------------------------------------------

// 書き出す中身とファイル名を作る(テストしやすいよう関数として独立)
function buildBackup() {
  return {
    filename: `ai-jissen-backup-${isoToday()}.json`,
    data: {
      app: "ai-jissen-assist", // このアプリのバックアップである印
      version: 1,
      exportedAt: new Date().toISOString(),
      records: loadRecords(),
      stats: loadStats(),
    },
  };
}

// 「すべての記録を書き出す」ボタン
function onExportClick() {
  if (loadRecords().length === 0) {
    showToast("⚠ 書き出す記録がありません");
    return;
  }
  const backup = buildBackup();
  // ファイルとしてダウンロードさせる定番の方法
  const blob = new Blob([JSON.stringify(backup.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backup.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("✔ バックアップを書き出しました");
}

// 文字列でない値を安全に文字列へそろえる(変な値が混ざっても壊れないように)
function toSafeString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

// バックアップの中身を検証する。
// 問題なければ { ok: true, records, stats }、問題があれば { ok: false, reason } を返す
function validateBackup(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "バックアップファイルの形式ではありません" };
  }
  if (!Array.isArray(data.records)) {
    return { ok: false, reason: "記録データ(records)が見つかりません" };
  }

  const cleaned = [];
  for (const r of data.records) {
    if (typeof r !== "object" || r === null) {
      return { ok: false, reason: "記録の形式が正しくありません" };
    }
    // 最低限必要な3項目を厳しくチェック
    if (typeof r.id !== "number" || !Number.isFinite(r.id)) {
      return { ok: false, reason: "記録の番号(id)が正しくありません" };
    }
    if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      return { ok: false, reason: "記録の日付が正しくありません" };
    }
    if (typeof r.task !== "string" || r.task.trim() === "") {
      return { ok: false, reason: "記録の作業内容が空になっています" };
    }
    // 必要な項目だけを取り出して作り直す(余計なデータを持ち込まない)
    cleaned.push({
      id: r.id,
      date: r.date,
      task: r.task,
      tools: toSafeString(r.tools),
      time: toSafeString(r.time),
      done: toSafeString(r.done),
      fail: toSafeString(r.fail),
      learn: toSafeString(r.learn),
      income: toSafeString(r.income),
      tomorrow: toSafeString(r.tomorrow),
    });
  }

  // 統計(プロンプト作成回数)はあれば取り込む(なくてもよい)
  let stats = null;
  if (typeof data.stats === "object" && data.stats !== null) {
    stats = {
      notePrompts: Number(data.stats.notePrompts) || 0,
      xPosts: Number(data.stats.xPosts) || 0,
    };
  }

  return { ok: true, records: cleaned, stats };
}

// バックアップ文字列を取り込む。検証に失敗したら保存データには一切触れない。
// mode: "merge"(追加)または "replace"(置き換え)
function importBackupText(text, mode) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: "⚠ JSONファイルとして読み取れませんでした" };
  }

  const result = validateBackup(data);
  if (!result.ok) {
    return { ok: false, message: "⚠ " + result.reason };
  }

  if (mode === "replace") {
    saveRecords(result.records);
    if (result.stats) saveStats(result.stats);
    return { ok: true, message: `✔ ${result.records.length}件の記録に置き換えました` };
  }

  // 追加モード:同じid(同じ記録)は取り込まない
  const current = loadRecords();
  const existingIds = new Set(current.map((r) => r.id));
  const added = result.records.filter((r) => !existingIds.has(r.id));
  saveRecords(current.concat(added));
  const skipped = result.records.length - added.length;
  return {
    ok: true,
    message: `✔ ${added.length}件を追加しました` + (skipped > 0 ? `(すでにある${skipped}件はスキップ)` : ""),
  };
}

// 「ファイルを選んで復元」ボタン
// 「置き換え」モードのときは、削除と同じ2回タップ方式で確認する
let importConfirmTimer = null;

function onImportButtonClick() {
  const btn = $("btn-import");
  const mode = document.querySelector('input[name="import-mode"]:checked').value;

  if (mode === "replace" && btn.dataset.confirming !== "true") {
    btn.dataset.confirming = "true";
    btn.textContent = "今の記録は消えます。本当に置き換える?";
    importConfirmTimer = setTimeout(() => {
      btn.dataset.confirming = "false";
      btn.textContent = "ファイルを選んで復元";
    }, 4000);
    return;
  }

  clearTimeout(importConfirmTimer);
  btn.dataset.confirming = "false";
  btn.textContent = "ファイルを選んで復元";
  $("import-file").click(); // ファイル選択画面を開く
}

// ファイルが選ばれたら読み込む
function onImportFileChange(event) {
  const file = event.target.files[0];
  if (!file) return;
  const mode = document.querySelector('input[name="import-mode"]:checked').value;

  const reader = new FileReader();
  reader.onload = () => {
    const result = importBackupText(reader.result, mode);
    showToast(result.message);
    if (result.ok) {
      renderHistory(); // 履歴を最新の状態に描き直す
    }
  };
  reader.onerror = () => showToast("⚠ ファイルを読み込めませんでした");
  reader.readAsText(file);

  event.target.value = ""; // 同じファイルをもう一度選べるようにリセット
}

// -----------------------------------------------------
// コピー機能
// -----------------------------------------------------
function copyText(sourceId) {
  const text = $(sourceId).value;
  if (!text) {
    showToast("⚠ コピーする内容がありません");
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => showToast("✔ コピーしました!"))
    .catch(() => {
      // 古いブラウザなどで失敗したときの保険(昔ながらの方法で再挑戦)
      $(sourceId).select();
      const ok = document.execCommand("copy");
      if (ok) {
        showToast("✔ コピーしました!");
      } else {
        showToast("⚠ コピーできませんでした。文章を長押しして手動でコピーしてください");
      }
    });
}

// -----------------------------------------------------
// 文字数カウント(X投稿文の下書き)
// -----------------------------------------------------
function updateCharCount() {
  const count = $("draft-input").value.length;
  $("char-count").textContent = count;
  $("char-warning").textContent = count > 140 ? "※140文字を超えています" : "";
}

// -----------------------------------------------------
// Xの投稿画面を開く(公式画面を開くだけ。投稿はしない)
// -----------------------------------------------------
function onOpenXClick() {
  window.open("https://x.com/intent/tweet", "_blank", "noopener");
}

// -----------------------------------------------------
// 起動時の準備
// -----------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  clearForm(); // 日付に今日を入れる

  // 下部メニュー
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showScreen(btn.dataset.screen));
  });

  // 右下の「+」ボタンと、ホームの「新しい実践を記録」ボタン
  $("fab").addEventListener("click", () => {
    clearForm();
    showScreen("record");
  });
  $("btn-goto-record").addEventListener("click", () => {
    clearForm();
    showScreen("record");
  });

  // 記録画面
  $("btn-save").addEventListener("click", onSaveClick);
  $("btn-cancel-edit").addEventListener("click", () => {
    clearForm();
    showToast("編集をキャンセルしました");
  });

  // 履歴画面(バックアップ)
  $("btn-export").addEventListener("click", onExportClick);
  $("btn-import").addEventListener("click", onImportButtonClick);
  $("import-file").addEventListener("change", onImportFileChange);

  // 発信画面
  $("btn-note").addEventListener("click", onNotePromptClick);
  $("btn-post").addEventListener("click", onPostPromptClick);
  $("btn-reply").addEventListener("click", onReplyPromptClick);
  $("btn-copy-prompt").addEventListener("click", () => copyText("prompt-output"));
  $("btn-copy-reply").addEventListener("click", () => copyText("reply-output"));
  $("btn-copy-draft").addEventListener("click", () => copyText("draft-input"));
  $("draft-input").addEventListener("input", updateCharCount);
  $("btn-open-x").addEventListener("click", onOpenXClick);

  // 最初の画面(ホーム)を描画
  renderHome();

  // PWA:サービスワーカー登録(http/httpsで開いたときだけ。file://では動かないため)
  if ("serviceWorker" in navigator && (location.protocol === "http:" || location.protocol === "https:")) {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch((e) => console.log("Service Worker の登録に失敗しました", e));
  }
});
