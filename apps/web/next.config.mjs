// AdDroid OSS — Next.js config.
//
// localhost-only / outbound-only 制約のため、画像最適化など外部リソースを取得する
// 機能は無効化する。`next dev`/`next start` の hostname も 127.0.0.1 を指定する。

// トンネル等 127.0.0.1 以外のオリジンから dev サーバへ入る場合だけ設定する。
// Next 16 は localhost 以外のオリジンからの /_next/* (HMR 含む) をブロックするため、
// 未設定だと画面は描画されてもハイドレーションが走らずボタンが無反応になる。
//   例: ADDROID_DEV_ORIGINS=adops.example.com,adops2.example.com
// Web UI 自体に認証は無い。外部公開するなら Cloudflare Access 等の認証プロキシを
// 必ず前段に置くこと。docs/SECURITY.md §1.1 を参照。
const devOrigins = (process.env.ADDROID_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(devOrigins.length > 0 ? { allowedDevOrigins: devOrigins } : {}),
  images: {
    // 画像最適化を行わない (outbound-only ポリシー & ローカル静的アセットのみ想定)
    unoptimized: true,
  },
  typedRoutes: false,
  // 共有 packages/* を Next.js のトランスパイル対象に含める
  transpilePackages: [
    "@addroid/db",
    "@addroid/config",
    "@addroid/queue",
    "@addroid/github-adapter",
  ],
  // 共有 packages/* は ESM ("type": "module") のため `./foo.js` の形で相互 import している。
  // Next.js (webpack) の既定では `.js` 指定子から `.ts` ソースに解決されないため、
  // extensionAlias を明示して .js → .ts/.tsx も探索するようにする。
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
