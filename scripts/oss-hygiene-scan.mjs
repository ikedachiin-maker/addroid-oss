#!/usr/bin/env node
// AdDroid OSS — secret / personal-data / hardcoded-value scan.
//
// 目的:
//   "Secret/hardcoded-value scans find no committed token, personal path,
//    personal GitHub account, local credential, or unsafe environment default."
//
// 動作:
//   - `git ls-files` で tracked file のみを走査する (untracked / gitignored は対象外)。
//   - テキストファイルは行単位で各禁止パターン (個人パス / 個人アカウント / token 形状 /
//     既知のローカル credential / unsafe default) を grep する。
//   - バイナリ (画像 / アーカイブ) は **silently skip しない**。printable ASCII の
//     run を抽出して `binarySafe: true` の rule (個人パス / 個人 GitHub login / token
//     形状 / private key block / 個人 DB credential URL) を適用する。これにより
//     スクリーンショット PNG の tEXt / EXIF メタデータに混ざった個人パスや token を
//     検出する (regression fix: 「コミット済 PNG が個人 path を晒したまま通っていた」回避)。
//   - 行末に `oss-hygiene-allow: <reason>` の注釈があるか、ファイル単位の allow-list
//     (この script 内の DOCUMENTED_FIXTURES) に該当する場合は抑止する。
//   - 1 件でも検出すれば exit 1。何も検出しなければ "[oss-hygiene] OK" を出して exit 0。
//
// CI 連携:
//   `.github/workflows/ci.yml` の `OSS hygiene scan` step で呼ばれる。Fork の PR でも
//   secrets なしで通る。
//
// ローカル実行:
//   node scripts/oss-hygiene-scan.mjs
//   node scripts/oss-hygiene-scan.mjs --json   # machine-readable
//   node scripts/oss-hygiene-scan.mjs --fix-suggest  # 各検出の修正ヒントを出す
//
// 制限:
//   - 完全な静的解析ではない。コミット直前の最後の防衛線 (build-time gate) と位置づけ、
//     runtime の sanitize-on-render と二重防御する。
//   - false positive を抑えるために allow-list を持つ。allow-list の追加は PR で議論する。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

const ARG_JSON = process.argv.includes("--json");
const ARG_FIX = process.argv.includes("--fix-suggest");

// ----------------------------------------------------------------------------
// Personal GitHub login denylist (config-driven, never committed)
// ----------------------------------------------------------------------------
//
// the current implementation は「個人 GitHub アカウント名そのものをこのリポジトリに commit しない」
// ことを acceptance に含める。よって検出対象の login 群は **env 経由でのみ** 与え、
// tracked source には 1 文字も書かない。
//
// 設定:
//   export ADDROID_PERSONAL_GITHUB_DENYLIST="login-a,login-b"
// (CI / pre-commit hook 側で operator / fork maintainer が設定する想定)
//
// 規約:
//   - GitHub login の文法 (英数 + 連続しないハイフン、最大 39 文字) に合致しない
//     値は無視する。これにより env に誤って path や token が混入しても
//     正規表現が壊れない。
//   - denylist が空なら rule は `/(?!)/` (絶対にマッチしない) に降格し、
//     構造的に rule は残す。fork maintainer が後から env を設定するだけで
//     有効化できる (コード変更不要)。
//   - コメント / label / hint いずれにも「具体的な個人名の例示」を書かない。
function loadPersonalGithubDenylist() {
  const raw = process.env.ADDROID_PERSONAL_GITHUB_DENYLIST || "";
  const validLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && validLogin.test(s));
}

function buildPersonalGithubLoginPattern(logins) {
  if (logins.length === 0) {
    // 絶対にマッチしない RegExp。
    return /(?!)/;
  }
  // login は上で英数 + ハイフンに制限済なので regex meta は出ない。
  const alt = logins.join("|");
  return new RegExp(`\\b(?:${alt})\\b`);
}

// 事業ドメイン / 自前ホスト名の denylist。GitHub login と同じ規約で env から読む:
//   export ADDROID_PERSONAL_HOSTNAME_DENYLIST="example.com,ops.example.net"
// トンネル公開時のホスト名を next.config などに直書きしたまま配布する事故を防ぐ。
function loadPersonalHostnameDenylist() {
  const raw = process.env.ADDROID_PERSONAL_HOSTNAME_DENYLIST || "";
  const validHostname = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes(".") && validHostname.test(s));
}

function buildPersonalHostnamePattern(hostnames) {
  if (hostnames.length === 0) {
    return /(?!)/;
  }
  // hostname は上で英数 + ドット + ハイフンに制限済。ドットのみ escape する。
  const alt = hostnames.map((h) => h.replace(/\./g, "\\.")).join("|");
  return new RegExp(`\\b(?:${alt})\\b`, "i");
}

const PERSONAL_GITHUB_LOGINS = loadPersonalGithubDenylist();
const PERSONAL_HOSTNAMES = loadPersonalHostnameDenylist();

// テスト / mock / placeholder は架空の Meta ID を大量に使うため、ID 系 rule の
// 対象から外す。実 ID の混入を止めたいのは配布物として動く source と docs。
const EXCLUDE_FIXTURE_FILES = [
  /^(?!.*(?:__tests__\/|\/mock|mock\.ts|placeholder|\.test\.|package-lock\.json)).*$/,
];

// ----------------------------------------------------------------------------
// パターン定義
// ----------------------------------------------------------------------------
//
// 各 rule:
//   id          : ログ / JSON 出力で使う識別子
//   label       : 人間向け説明
//   pattern     : 検出 RegExp (g フラグ不要; マッチしたら 1 件として扱う)
//   hint        : 修正方法のヒント
//   severity    : "error" | "warn" (warn は exit code に影響しない)
//   onlyFiles   : 検査対象を絞る repo-relative path 正規表現 (省略時は全テキスト)
//   binarySafe  : true なら、バイナリファイルから抽出した printable ASCII run にも
//                 適用する (例: PNG メタデータの個人 path / token の検出)。
//                 線形的な ^...$ アンカーや行コンテキストに依存する rule は false。
const RULES = [
  {
    id: "personal-absolute-path-unix",
    label: "Unix-style personal absolute path",
    pattern: /\/Users\/[A-Za-z][A-Za-z0-9._-]+\/|\/home\/[A-Za-z][A-Za-z0-9._-]+\//,
    hint:
      "個人パスを書かない。`~/.addroid/...` や `process.env.HOME` 経由で解決し、" +
      "ドキュメントでは `~/<rest>` を使うこと。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "personal-absolute-path-windows",
    label: "Windows-style personal absolute path",
    // C:\Users\<name>\ または C:\\Users\\<name>\\ どちらにもマッチ。
    pattern: /C:[\\/]+Users[\\/]+[A-Za-z][A-Za-z0-9._-]+[\\/]+/,
    hint: "個人パスを書かない。HOME-anchored な相対表現に置換する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "personal-github-login",
    label: "Personal GitHub login (config-driven denylist)",
    // 検出対象の login 群は env `ADDROID_PERSONAL_GITHUB_DENYLIST` から読む
    // (個人名そのものを tracked source に書かないため)。env 未設定時は
    // この rule は no-op になる。
    pattern: buildPersonalGithubLoginPattern(PERSONAL_GITHUB_LOGINS),
    hint:
      "個人 GitHub アカウント名をハードコードしない。owner は package.json#repository.url 由来、" +
      "または DB / config / env から読む。検出対象の login は env " +
      "`ADDROID_PERSONAL_GITHUB_DENYLIST=<login1>,<login2>` で設定する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "meta-ad-account-id",
    label: "Real Meta ad account id (act_...)",
    // placeholder は 10 桁 (act_1234567890 / act_9876543210) で運用しているため、
    // 11 桁以上を実アカウント ID とみなす。実 ID は 15-16 桁。
    pattern: /\bact_\d{11,}\b/,
    onlyFiles: EXCLUDE_FIXTURE_FILES,
    hint:
      "実在の広告アカウント ID を書かない。アカウントは DB / ops repo の " +
      "accounts/<key>/ から解決する。例示には act_1234567890 を使う。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "meta-object-id",
    label: "Real Meta object id (campaign / adset / ad)",
    // Meta の campaign / adset / ad id は 1 始まりの 17 桁以上。ms 単位の
    // epoch (13 桁) や npm の integrity 文字列とは桁数で分離できる。
    // lock ファイル等のノイズを避けるため source tree に限定する。
    pattern: /\b1\d{16,}\b/,
    onlyFiles: EXCLUDE_FIXTURE_FILES,
    hint:
      "実在の campaign / adset / ad ID を書かない。ID は Meta Graph API か " +
      "ops repo の YAML から解決する。",
    severity: "error",
    binarySafe: false,
  },
  {
    id: "personal-hostname",
    label: "Personal / business hostname (config-driven denylist)",
    // 検出対象は env `ADDROID_PERSONAL_HOSTNAME_DENYLIST` から読む
    // (ドメインそのものを tracked source に書かないため)。未設定時は no-op。
    pattern: buildPersonalHostnamePattern(PERSONAL_HOSTNAMES),
    hint:
      "自前ドメイン / トンネルのホスト名をハードコードしない。dev origin は env " +
      "`ADDROID_DEV_ORIGINS` から読む。検出対象は env " +
      "`ADDROID_PERSONAL_HOSTNAME_DENYLIST=<host1>,<host2>` で設定する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "openai-api-key",
    label: "OpenAI-style secret key (sk-...)",
    // sk-XXXX で OpenAI のキー形状。32+ 文字を要求して `sk-mock` 等を除外する。
    pattern: /\bsk-[A-Za-z0-9]{32,}\b/,
    hint: "OpenAI / 互換 API キーをコードに書かない。`oauth_tokens` 経由で暗号化保存する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "anthropic-api-key",
    label: "Anthropic API key (sk-ant-...)",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    hint: "Anthropic API キーをコードに書かない。`oauth_tokens` 経由で暗号化保存する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "github-pat",
    label: "GitHub Personal Access Token (ghp_ / github_pat_)",
    pattern: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
    hint: "GitHub PAT をコードに書かない。OAuth Device Flow + `oauth_tokens` 経由のみ。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "slack-bot-token",
    label: "Slack Bot Token (xoxb-...)",
    // xoxb-N-N-N-<secret> の本物形状。テストフィクスチャ `xoxb-1234567890-abcdef` (3 セグメント)
    // は本物形状 (4 セグメント) とは合わないため擬陽性しない。
    pattern: /\bxoxb-\d{8,}-\d{8,}-\d{8,}-[A-Za-z0-9]{20,}\b/,
    hint: "Slack Bot トークンをコードに書かない。`addroid auth slack` で暗号化保存する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "slack-app-token",
    label: "Slack App-Level Token (xapp-...)",
    pattern: /\bxapp-\d+-[A-Z0-9]+-\d{8,}-[A-Za-z0-9]{30,}\b/,
    hint: "Slack App-Level トークンをコードに書かない。`addroid auth slack` で暗号化保存する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "slack-user-token",
    label: "Slack User Token (xoxp-...)",
    pattern: /\bxoxp-\d{8,}-\d{8,}-\d{8,}-[A-Za-z0-9]{20,}\b/,
    hint: "Slack User トークンをコードに書かない。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "aws-access-key",
    label: "AWS Access Key Id (AKIA...)",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    hint: "AWS Access Key Id をコードに書かない。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "google-api-key",
    label: "Google API Key (AIza...)",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    hint: "Google API Key をコードに書かない。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "private-key-block",
    label: "PEM-style private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/,
    hint: "private key をコードに書かない。.gitignore で確実に除外する。",
    severity: "error",
    binarySafe: true,
  },
  {
    id: "real-encryption-key-assignment",
    label: "Non-placeholder ENCRYPTION_KEY assignment in .env.example or committed config",
    // .env.example / docs に `ENCRYPTION_KEY=<48 文字以上の base64-ish 値>` が書かれてい
    // ないか。"replace-with-..." / "your-..." / "example-..." 等は placeholder として許容。
    pattern:
      /^\s*ENCRYPTION_KEY\s*=\s*(?!.*(?:replace-with|placeholder|your-|example|<.+?>|change-?me|REPLACE|REDACTED|test-encryption-key|addroid-addroid-local|generate))[A-Za-z0-9+/=_-]{32,}\s*$/m,
    hint:
      "`.env.example` の ENCRYPTION_KEY は placeholder のみ。実値は `.env` / `.env.local` のみに" +
      "保存する (どちらも .gitignore で除外)。",
    severity: "error",
    onlyFiles: [/\.env\.example$/, /docs\/.*\.md$/i],
    binarySafe: false, // ^...$ アンカー + 行コンテキスト依存
  },
  {
    id: "unsafe-env-default-disabled",
    label: "Insecure default — auth / crypto / TLS disabled",
    // 真っ平な `*_DISABLED=1`、`SKIP_AUTH=1` などのパターンを警告。
    pattern: /\b(?:DISABLE_AUTH|SKIP_AUTH|INSECURE_TLS|TLS_REJECT_UNAUTHORIZED\s*=\s*0|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0)\b/,
    hint: "認証 / TLS を無効化する unsafe default を commit しない。",
    severity: "error",
    binarySafe: false, // env 名はソースコード文脈に限定
  },
  {
    id: "unsafe-default-db-credentials",
    label:
      "Concrete local DB credentials in URL (user==password, e.g., addroid:addroid)",
    // `<scheme>://<user>:<pass>@...` で user==pass の形 (ローカル DB 既定値の典型)。
    // 例: postgres://addroid:addroid@..., mysql://root:root@..., mongodb://admin:admin@...
    // 同形は .env.example / docs / config 既定値で operator が「そのまま使う」誘惑が強く、
    // OSS テンプレートには載せてはならない。CI の使い捨て service container や test
    // fixture で正当に使う場合は行末に `oss-hygiene-allow: <reason>` を付ける。
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis):\/\/([A-Za-z][A-Za-z0-9_-]*):\1@/,
    hint:
      "ローカル DB credential を commit しない。`.env.example` / docs では " +
      "`USER:PASSWORD` のような placeholder のみ使用し、実値は `.env` / `.env.local` " +
      "(どちらも .gitignore 済) に書く。CI / test fixture など正当な場合は行末に " +
      "`oss-hygiene-allow: <reason>` を付ける。",
    severity: "error",
    binarySafe: true, // PNG メタデータ等に DB URL が混入する可能性に備える
  },
];

// ----------------------------------------------------------------------------
// Allow-list (file-level)
// ----------------------------------------------------------------------------
//
// 以下のファイルは検査対象から完全に除外する。allow-list は narrow に保つ:
// 「禁止 pattern を文書化する性質上、検出 rule そのものを文中に書かざるを得ない」
// ファイルだけを skip し、それ以外の docs / 設計成果物は通常通り走査する。
// TROUBLESHOOTING.md / docs/ARCHITECTURE.md のような公開文書を full-skip にすると、
// 将来そこに `addroid:addroid` のような local DB credential や個人 GitHub login が
// コミットされても scan が silently miss してしまうため、allow-list は最小限に保つ。
//
//   - LICENSE: Apache-2.0 法的本文
//   - package-lock.json: npm が生成する dependency 木 (中に sk- 形状の sha512 が出る)
//   - .git, node_modules: そもそも `git ls-files` で出てこないが念のため
//   - 画像 / アーカイブはバイナリ判定で別途除外
//   - この scan script 自体は説明文に検出パターンを含むので除外
//   - docs/SECURITY.md: チェックリスト本文に `/Users/<personal>` 等の placeholder 例示を含む
//   - prisma/migrations: SQL ダンプ
//
// 個別行を意図的に通したい場合は行末に `oss-hygiene-allow: <reason>` を付ける
// (file-level の full-skip より narrow で、PR diff にも理由が残る)。
// allow-list 追加は PR で議論する (CONTRIBUTING.md #4.3)。
const FILE_SKIP_PATTERNS = [
  /^LICENSE$/,
  /^apps\/cli\/LICENSE$/,
  /^package-lock\.json$/,
  /^\.gitignore$/,
  /^scripts\/oss-hygiene-scan\.mjs$/,
  /^docs\/SECURITY\.md$/,
  /^prisma\/migrations\//,
];

// バイナリ判定 (拡張子ベース)。
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico",
  ".pdf",
  ".zip", ".tgz", ".tar", ".gz", ".bz2", ".xz",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".mov",
]);

// ----------------------------------------------------------------------------
// 既知の documented test fixture (line-level 個別許可)
// ----------------------------------------------------------------------------
// これらは「禁止する値の形」だが、redactor / sanitize-on-render の動作確認テストの
// fixture として正当に使われる。テストファイルの中でだけ許可する。
//
// パターン: `<file glob>::<literal>` — file glob にマッチし、行に literal を含む場合に限り
// その行を allow とする。
const DOCUMENTED_FIXTURES = [
  // Mock Meta adapter の deterministic fixture (`packages/meta-adapter/src/mock.ts` で
  // 1234567890 / 9876543210 を使う。Web UI にも `act_1234567890` を placeholder として表示)。
  { fileRegex: /^(?:apps|packages)\/.*\/(?:__tests__\/.*\.(?:ts|tsx|mjs|js)|mock\.ts|.*placeholder.*)$/, contains: "act_1234567890" },
  { fileRegex: /^(?:apps|packages)\/.*\/(?:__tests__\/.*\.(?:ts|tsx|mjs|js)|mock\.ts|.*placeholder.*)$/, contains: "act_9876543210" },
  { fileRegex: /^apps\/web\/app\/accounts\/AddAccountForm\.tsx$/, contains: "act_1234567890" },
  { fileRegex: /^apps\/web\/app\/api\/oauth\/meta\/callback\/route\.ts$/, contains: "act_1234567890" },
  // Slack channel id ダミー (test fixture)。
  { fileRegex: /^(?:apps|packages)\/.*\/__tests__\/.*\.(?:ts|tsx|mjs|js)$/, contains: "C012ABCDEF" },
  // テスト用 sk- フィクスチャ (redactor が削るかを検証する)。
  { fileRegex: /^packages\/(?:config|llm-provider|queue)\/.*\/__tests__\/.*\.(?:ts|tsx|mjs|js)$/, contains: "sk-" },
  // smoke-test の固定 ENCRYPTION_KEY (ゼロバイト文字列)。
  { fileRegex: /^apps\/cli\/scripts\/smoke-test\.mjs$/, contains: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function listTrackedFiles() {
  const out = spawnSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) {
    process.stderr.write(`[oss-hygiene] failed to run "git ls-files": ${out.stderr}\n`);
    process.exit(2);
  }
  return out.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isBinaryByExt(file) {
  const ext = path.extname(file).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isFileSkipped(file) {
  return FILE_SKIP_PATTERNS.some((re) => re.test(file));
}

function isLineAllowedByAnnotation(line) {
  // `// oss-hygiene-allow: <reason>` または `# oss-hygiene-allow: <reason>` 形式。
  return /\boss-hygiene-allow\b/.test(line);
}

function isLineAllowedByFixture(file, line) {
  for (const f of DOCUMENTED_FIXTURES) {
    if (f.fileRegex.test(file) && line.includes(f.contains)) return true;
  }
  return false;
}

function ruleAppliesToFile(rule, file) {
  if (!rule.onlyFiles) return true;
  return rule.onlyFiles.some((re) => re.test(file));
}

// バイナリファイル (PNG / PDF / 等) から printable ASCII の run を抽出する。
// 6+ 連続する `[\x20-\x7e]` を取り出し、メタデータ / EXIF / tEXt チャンクに紛れる
// 個人 path や token を後段の rule で grep できるようにする。
// pixel データそのものの「見た目で読める文字」 (= OCR が必要) は対象外。
function extractPrintableStrings(buffer) {
  const PRINTABLE_RUN = /[\x20-\x7e]{6,}/g;
  const text = buffer.toString("latin1");
  return text.match(PRINTABLE_RUN) || [];
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

const findings = [];
const files = listTrackedFiles();
let scannedTextFiles = 0;
let scannedBinaryFiles = 0;
let skippedAllowList = 0;

for (const rel of files) {
  if (isFileSkipped(rel)) {
    skippedAllowList += 1;
    continue;
  }
  const abs = path.join(REPO_ROOT, rel);
  const declaredBinary = isBinaryByExt(rel);

  // バイナリ拡張子のファイルは buffer として読み、printable string を抽出して
  // binarySafe rule を当てる (regression fix)。
  if (declaredBinary) {
    let buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    scannedBinaryFiles += 1;
    const strings = extractPrintableStrings(buffer);
    for (const str of strings) {
      if (isLineAllowedByAnnotation(str)) continue;
      if (isLineAllowedByFixture(rel, str)) continue;
      for (const rule of RULES) {
        if (!rule.binarySafe) continue;
        if (!ruleAppliesToFile(rule, rel)) continue;
        const m = rule.pattern.exec(str);
        if (m) {
          findings.push({
            rule: rule.id,
            severity: rule.severity,
            label: rule.label,
            file: rel,
            line: 0, // バイナリのため行番号なし
            match: m[0],
            hint: rule.hint,
            binary: true,
          });
        }
        if (rule.pattern.global) rule.pattern.lastIndex = 0;
      }
    }
    continue;
  }

  let content;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") continue; // submodule placeholder 等
    throw err;
  }
  // null byte を含むファイル = binary 扱い (拡張子で漏れた場合の保険)。
  // テキスト rule を行単位で当てると擬陽性が出やすいので、binarySafe rule のみ
  // 抽出文字列に対して当てる (declaredBinary と同じ経路)。
  if (content.indexOf("\x00") !== -1) {
    const buffer = Buffer.from(content, "binary");
    scannedBinaryFiles += 1;
    const strings = extractPrintableStrings(buffer);
    for (const str of strings) {
      if (isLineAllowedByAnnotation(str)) continue;
      if (isLineAllowedByFixture(rel, str)) continue;
      for (const rule of RULES) {
        if (!rule.binarySafe) continue;
        if (!ruleAppliesToFile(rule, rel)) continue;
        const m = rule.pattern.exec(str);
        if (m) {
          findings.push({
            rule: rule.id,
            severity: rule.severity,
            label: rule.label,
            file: rel,
            line: 0,
            match: m[0],
            hint: rule.hint,
            binary: true,
          });
        }
        if (rule.pattern.global) rule.pattern.lastIndex = 0;
      }
    }
    continue;
  }

  scannedTextFiles += 1;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (isLineAllowedByAnnotation(line)) continue;
    if (isLineAllowedByFixture(rel, line)) continue;
    for (const rule of RULES) {
      if (!ruleAppliesToFile(rule, rel)) continue;
      const m = rule.pattern.exec(line);
      if (m) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          label: rule.label,
          file: rel,
          line: i + 1,
          match: m[0],
          hint: rule.hint,
          binary: false,
        });
      }
      // pattern の lastIndex を毎回リセット (g flag 不使用だが念のため)。
      if (rule.pattern.global) rule.pattern.lastIndex = 0;
    }
  }
}

const errors = findings.filter((f) => f.severity === "error");
const warnings = findings.filter((f) => f.severity === "warn");

if (ARG_JSON) {
  const payload = {
    scanned_text_files: scannedTextFiles,
    scanned_binary_files: scannedBinaryFiles,
    skipped_allow_list: skippedAllowList,
    error_count: errors.length,
    warn_count: warnings.length,
    findings,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(errors.length === 0 ? 0 : 1);
}

const w = (s) => process.stdout.write(s + "\n");
w(
  `[oss-hygiene] scanned ${scannedTextFiles} text + ${scannedBinaryFiles} binary file(s) ` +
    `(${skippedAllowList} allow-listed)`
);
if (findings.length === 0) {
  w("[oss-hygiene] OK — no findings.");
  process.exit(0);
}

const groupBy = (arr, key) => {
  const out = new Map();
  for (const x of arr) {
    const k = x[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(x);
  }
  return out;
};

const byRule = groupBy(findings, "rule");
for (const [ruleId, items] of byRule) {
  const sample = items[0];
  w("");
  w(`[${sample.severity.toUpperCase()}] ${sample.label} (${ruleId}) — ${items.length} match(es)`);
  for (const it of items) {
    // 一致部分を redact して出力 (loud な token をログに残さない)。
    const redactedMatch = it.match.length > 8
      ? `${it.match.slice(0, 4)}...${it.match.slice(-2)}`
      : "***";
    const locator = it.binary ? `${it.file}:<binary>` : `${it.file}:${it.line}`;
    w(`    ${locator}  match=${redactedMatch}`);
  }
  if (ARG_FIX) {
    w(`    hint: ${sample.hint}`);
  }
}

if (errors.length > 0) {
  w("");
  w(
    `[oss-hygiene] FAIL — ${errors.length} error finding(s), ${warnings.length} warn finding(s).`
  );
  w("    修正後に再度 \`npm run oss:hygiene\` で確認してください。");
  w("    特定の行を意図的に許可する場合は行末に \`oss-hygiene-allow: <reason>\` を追加します。");
  process.exit(1);
}

w("");
w(`[oss-hygiene] WARN — ${warnings.length} warn finding(s) (exit 0).`);
process.exit(0);
