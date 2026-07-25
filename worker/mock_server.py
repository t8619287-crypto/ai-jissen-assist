# =====================================================
# ローカルテスト用のモックAPIサーバー(OpenAI APIキー不要・無料)
#
# 本物のWorkerと同じ入り口(認証・検証・返答の形)を再現します。
# AIは呼ばず、決まった文章を返すだけなので、料金はかかりません。
#
# 使い方:
#   python worker/mock_server.py
#   → http://localhost:8787 で起動
#   → アプリの「AI生成の設定」に
#      URL: http://localhost:8787 / トークン: test-token を設定
# =====================================================
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8787
APP_ACCESS_TOKEN = "test-token"
ALLOWED_ORIGINS = ["http://localhost:8765", "https://t8619287-crypto.github.io"]

FIELD_LIMITS = {
    "date": 10, "tools": 100, "task": 200, "time": 50, "done": 600,
    "fail": 600, "learn": 600, "income": 50, "tomorrow": 300, "extra": 500,
}
MAX_BODY_BYTES = 20 * 1024


class MockHandler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-store")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {APP_ACCESS_TOKEN}"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return self._json({"error": "このサイトからの利用は許可されていません(Origin不一致)"}, 403)
        if not self._auth_ok():
            return self._json({"error": "アクセストークンが正しくありません。アプリの「AI生成の設定」を確認してください"}, 401)
        if self.path == "/api/health":
            return self._json({"ok": True, "model": "mock(テスト用・AI未使用)"})
        return self._json({"error": "エンドポイントが見つかりません"}, 404)

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return self._json({"error": "このサイトからの利用は許可されていません(Origin不一致)"}, 403)
        if not self._auth_ok():
            return self._json({"error": "アクセストークンが正しくありません。アプリの「AI生成の設定」を確認してください"}, 401)
        if self.path != "/api/generate":
            return self._json({"error": "エンドポイントが見つかりません"}, 404)

        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            return self._json({"error": "リクエストが大きすぎます"}, 413)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return self._json({"error": "リクエストの形式が正しくありません"}, 400)

        # 本物のWorkerと同じ検証
        gen_type = body.get("type")
        if gen_type not in ("x", "note"):
            return self._json({"error": "生成種類は x または note を指定してください"}, 400)
        record = body.get("record") or {}
        for field, limit in FIELD_LIMITS.items():
            if field == "extra":
                continue
            value = record.get(field)
            if value is None:
                continue
            if not isinstance(value, str):
                return self._json({"error": f"{field} は文字列で指定してください"}, 400)
            if len(value) > limit:
                return self._json({"error": f"{field} が長すぎます(最大{limit}文字)"}, 400)
        if not (record.get("task") or "").strip():
            return self._json({"error": "取り組んだ作業(task)が空です。記録を選んでください"}, 400)

        options = body.get("options") or {}
        extra = options.get("extra") or ""

        if gen_type == "x":
            task = record.get("task", "")[:30]
            income = record.get("income") or "0円"
            learn = (record.get("learn") or "学びを記録中")[:25]
            tomorrow = (record.get("tomorrow") or "続きを進める")[:20]
            tag = " #AI副業" if options.get("hashtags") else ""
            posts = [
                {"label": "素直な実践記録",
                 "text": f"今日の収益は{income}。{task}に取り組んだ。学び:{learn}。明日は{tomorrow}。{tag}".strip()},
                {"label": "共感型",
                 "text": f"収益{income}の1日。{task}をコツコツ。{learn}と気づけただけで前進。明日は{tomorrow}。同じ初心者の方、一緒に頑張りましょう{tag}".strip()},
                {"label": "短く読みやすい",
                 "text": f"収益{income}/{task}/学び:{learn}/明日:{tomorrow}{tag}".strip()},
            ]
            # テスト用:補足情報に LONGTEST とあると、わざと140文字を超える案を混ぜる
            if "LONGTEST" in extra:
                posts[2]["text"] = "こ" * 150
            for p in posts:
                p["length"] = len(p["text"])
            return self._json({"type": "x", "posts": posts})

        # note記事のモック
        task = record.get("task", "作業")
        return self._json({
            "type": "note",
            "titles": [
                f"収益{record.get('income') or '0円'}でも続ける。{task}のリアルな記録",
                f"AI副業初心者が{task}をやってみた結果",
                f"{task}でつまずいた話と、そこからの学び",
            ],
            "recommendedTitle": f"AI副業初心者が{task}をやってみた結果",
            "intro": "AI副業を始めたばかりの初心者が、今日の実践をそのまま記録します。うまくいったことも、いかなかったことも正直に書きます。",
            "sections": [
                {"heading": "今日やったこと", "body": f"{task}に取り組みました。使ったツールは{record.get('tools') or '未記入'}、作業時間は{record.get('time') or '未記入'}です。{record.get('done') or ''}"},
                {"heading": "つまずいたこと", "body": record.get("fail") or "今日は大きなつまずきはありませんでした。"},
                {"heading": "学んだこと", "body": record.get("learn") or "記録を続けること自体が学びになっています。"},
            ],
            "summary": f"今日の収益は{record.get('income') or '0円'}でした。数字は小さくても、記録を続けて改善していきます。",
            "nextAction": record.get("tomorrow") or "明日も実践を続けます。",
            "hashtags": ["#AI副業", "#実践記録", "#初心者"],
        })

    def log_message(self, format, *args):
        print(f"[mock] {args[0]} {args[1]}")


if __name__ == "__main__":
    print(f"モックAPIサーバーを起動しました: http://localhost:{PORT}")
    print(f"アクセストークン: {APP_ACCESS_TOKEN}")
    HTTPServer(("127.0.0.1", PORT), MockHandler).serve_forever()
