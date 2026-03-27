import { execSync } from "node:child_process";

// Vercel Cron用の最小エンドポイント
// 実運用では src/index.ts のロジックを関数化して直接呼ぶのが理想ですが、
// 最小構成を優先して npm run dev を実行するサンプルにしています。
export default async function handler(_req: any, res: any) {
  try {
    execSync("npm run dev", { stdio: "inherit" });
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
}
