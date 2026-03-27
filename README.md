# notion-url-auto-fill

Notion の「過去記事URL管理」データベースに URL を貼るだけで、記事メタ情報を自動取得して各項目に書き戻す最小構成の実装です。  
Notion AI は使わず、Notion API + TypeScript で動作します。

---

## 1. ディレクトリ構成

```txt
notion-url-auto-fill/
├── .env.example
├── .github/
│   └── workflows/
│       └── notion-url-autofill.yml
├── api/
│   └── cron.ts
├── src/
│   └── index.ts
├── vercel.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## 2. セットアップ手順

1. リポジトリをクローン
2. 依存関係をインストール
3. `.env.example` を `.env` にコピー
4. Notion の Integration Token と Database ID を設定
5. `npm run dev` で実行

```bash
npm install
cp .env.example .env
npm run dev
```

---

## 3. package.json

```json
{
  "name": "notion-url-auto-fill",
  "version": "1.0.0",
  "description": "NotionデータベースのURLから記事情報を自動抽出して書き戻すスクリプト",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  },
  "keywords": [
    "notion",
    "automation",
    "typescript"
  ],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "@notionhq/client": "^2.3.0",
    "cheerio": "^1.1.2",
    "dotenv": "^16.6.1"
  },
  "devDependencies": {
    "@types/node": "^22.18.6",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3"
  }
}
```

---

## 4. tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 5. .env.example

```env
NOTION_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
REQUEST_TIMEOUT_MS=15000
USER_AGENT=notion-url-auto-fill-bot/1.0 (+https://example.com)
MAX_PAGES_PER_RUN=20
```

---

## 6. 実装コード一式

`src/index.ts` に集約しています。主な処理は次のとおりです。

- Notion DB から候補行を取得
- 未処理 / 未入力行を判定
- URL 取得・バリデーション
- HTML 取得（タイムアウトつき）
- メタ抽出（OGP / Twitter / title / JSON-LD）
- 本文候補抽出と日本語要約（120〜180文字）
- カテゴリ推定・タグ推定（簡易ルール）
- Notion への書き戻し
- 成功時 `Status=done` / 失敗時 `Status=error`
- `Error Note` と `Last Processed At` 更新
- `done` URL / canonical 重複スキップ

> 実ファイル: `src/index.ts`

---

## 7. README（このファイル）

この README にセットアップ、実行方法、Notion 側設定、定期実行例、運用のコツをまとめています。

---

## 8. Notion側で必要なプロパティ型の推奨

### 必須

- `Name` → **Title**
- `URL` → **URL**
- `Summary` → **Rich text**
- `Meta Description` → **Rich text**
- `OGP Image` → **URL**
- `Site Name` → **Rich text**
- `Author` → **Rich text**
- `Published Date` → **Date**
- `Category` → **Select**
- `Tags` → **Multi-select**
- `Status` → **Status**（または Select）
- `Error Note` → **Rich text**
- `Last Processed At` → **Date**

### 推奨追加

- `Source Type` → **Select**（note/blog/news/other）
- `Canonical URL` → **URL**
- `Domain` → **Rich text**
- `Retry Count` → **Number**

### Status候補（推奨）

- `pending`
- `retry`
- `done`
- `error`

---

## 9. 実行方法

### ローカル実行（最初の一歩）

```bash
npm install
cp .env.example .env
npm run dev
```

### 本番向け（ビルド後実行）

```bash
npm run build
npm run start
```

---

## 10. GitHub Actions 例

`.github/workflows/notion-url-autofill.yml` をそのまま利用できます。

必要な Secrets:

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`

実行頻度は 30 分ごとです（`cron: "*/30 * * * *"`）。

---

## 11. Vercel Cron 例

`vercel.json` + `api/cron.ts` をサンプルとして同梱しています。

- `vercel.json` で `/api/cron` を定期実行
- `api/cron.ts` から `npm run dev` を呼ぶ最小実装

> 実運用では、`src/index.ts` の処理を関数化して API から直接呼ぶ形にすると、より安定します。

---

## 12. 今後の拡張案

1. **抽出精度改善**
   - `@mozilla/readability` で本文抽出を強化
   - note / 特定ドメイン向け抽出を個別最適化

2. **再試行戦略**
   - `Retry Count` を加算し、一定回数で停止
   - 失敗理由別の待機時間を導入

3. **重複検知改善**
   - Canonical の正規化（末尾 `/`, UTM 除去）
   - URL ハッシュによる一意管理

4. **運用性改善**
   - Notion に「手動再処理フラグ」を追加
   - ログを JSON 出力して監視に流す

---

## Notion側の初期設定手順（初心者向け）

1. Notion でデータベース「過去記事URL管理」を作成
2. 上記プロパティを追加
3. Notion Integration を作成し Token を取得
4. 対象 DB に Integration を「招待」して編集権限を付与
5. DB URL から `NOTION_DATABASE_ID` を取得
6. `.env` に Token / Database ID を設定
7. `npm run dev` 実行

---

## 初心者がつまずきやすい点

- **Integration を DB に共有していない** → API で読めない/書けない
- **プロパティ名が一致しない** → `Name` と `タイトル` などでズレると更新失敗
- **Status の型違い** → Status/Select の差分で更新仕様が異なる
- **URL が URL型でない** → 取得時に空扱いになりやすい
- **Cloudflare/403** → 一部サイトは取得できず `error` になる（想定内）

---

## 一番簡単な運用方法

1. 新規行に URL を貼る（Status は空 or `pending`）
2. 定期実行（GitHub Actions）で自動処理
3. `error` 行だけ手動で URL 修正し `retry` に変更
4. 次回実行で再処理

---

## この構成でできること / できないこと

### できること

- URL ベースのメタ自動入力
- 簡易要約（日本語 120〜180 文字）
- カテゴリ/タグの初期推定
- エラー時の理由記録
- 再処理しやすい運用

### できないこと（現時点）

- JSレンダリング必須サイトの高精度抽出
- 高度な NLP 要約
- 完全な著者/公開日の保証
- 大規模データの高性能バッチ処理

---

## まず最初にやること（3ステップ）

1. **Notion DB に必要プロパティを作る**（特に `URL`, `Status`, `Error Note`）
2. **`.env` に Token / Database ID を設定して `npm run dev` 実行**
3. **`error` 行を `retry` に戻して再実行フローを確認**
