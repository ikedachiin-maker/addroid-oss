// AdDroid OSS — Next.js config.
//
// localhost-only / outbound-only 制約のため、画像最適化など外部リソースを取得する
// 機能は無効化する。`next dev`/`next start` の hostname も 127.0.0.1 を指定する。

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // CF Tunnel (addroid.ad-marketing.net) 経由の dev アクセスを許可する。
  // Next 16 は localhost 以外のオリジンからの /_next/* (HMR 含む) をブロックするため、
  // これが無いと画面は描画されてもハイドレーションが走らずボタンが無反応になる。
  allowedDevOrigins: ["addroid.ad-marketing.net"],
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
