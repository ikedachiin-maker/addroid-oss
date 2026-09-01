// `addroid init` — first-run wizard + ~/.addroid scaffold.
//
// 非 TTY / --non-interactive では従来どおり副作用を ~/.addroid に閉じた冪等
// scaffold として動作する。TTY では Project name / .env / DB setup / doctor までを
// 対話的に案内し、CLI リテラシー程度の利用者が手で .env を編集せずに進められる。
//
// Scaffold 動作:
//   1. ~/.addroid とサブディレクトリ (storage / logs / run) を mkdir -p
//   2. config.yaml が無ければ default を書き込み、あれば値を保持してスキーマ整形のみ
//   3. secrets.local.yaml が無ければ stub を作成 (gitignored)
//   4. database.urlRef を再評価 (DATABASE_URL の有無で更新)
//
// 再実行しても破壊的更新は行わない。slug / displayName / opsRepo 等の既存設定は保持する。

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readlineControl from "node:readline";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  AddroidConfigSchema,
  ConfigParseError,
  defaultAddroidConfig,
  ensureAddroidPaths,
  getCryptoBoundary,
  readLocalSecrets,
  readAddroidConfig,
  normalizeAddroidLanguagePreference,
  resolveAddroidLanguage,
  writeAddroidConfig,
  type AddroidConfig,
  type AddroidLanguagePreference,
} from "@addroid/config";
import {
  checkCodexCli,
  checkGithubCli,
  checkPlatform,
  checkPostgresVersion,
  type CheckResult,
} from "../lib/checks.js";
import { resolveRepoRoot } from "../lib/paths.js";
import { formatServiceStatus, installAddroidService } from "../lib/service.js";

const SECRETS_STUB =
  "# AdDroid OSS — local-only secrets. THIS FILE IS GITIGNORED.\n" +
  "# 例:\n" +
  "# github:\n" +
  "#   oauth:\n" +
  "#     clientId: \"...\"\n" +
  "#     clientSecret: \"...\"\n" +
  "# OAuth / API tokens are encrypted in oauth_tokens with ENCRYPTION_KEY.\n" +
  "# This file is local-only and chmod 0600; do not commit it.\n";

const DEFAULT_DATABASE_USER = "addroid";
const DEFAULT_DATABASE_NAME = "addroid";
const DEFAULT_DATABASE_HOST = "localhost";
const DEFAULT_DATABASE_PORT = "5432";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";
type PromptFn = (question: string, defaultValue?: string) => Promise<string>;
type ConfirmFn = (question: string, defaultYes?: boolean) => Promise<boolean>;
interface SelectOption {
  value: string;
  label: string;
  description: string;
}
type SelectFn = (
  question: string,
  options: readonly SelectOption[],
  defaultValue: string
) => Promise<string>;

export interface InitCommandOverrides {
  prompt?: PromptFn;
  confirm?: ConfirmFn;
  selectOption?: SelectFn;
  runAuthCommand?: (args: string[]) => Promise<number>;
  runCommand?: CommandRunner;
  readAuthState?: (env: NodeJS.ProcessEnv) => Promise<InitAuthState>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isTTY?: boolean;
  randomBytes?: (size: number) => Buffer;
}

interface InitOptions {
  interactive?: boolean;
  yes: boolean;
  installDeps: boolean;
  skipDeps: boolean;
  skipDbCreate: boolean;
  skipDbPush: boolean;
  dbPush: boolean;
  mockIntegrations: boolean;
  skipLinkCli: boolean;
  force: boolean;
  reauthMeta: boolean;
  reauthGithub: boolean;
  reauthLlm: boolean;
  noChat: boolean;
  noService: boolean;
  projectName?: string;
  language?: AddroidLanguagePreference;
  databaseUrl?: string;
  envFile?: string;
  help: boolean;
}

interface InitAuthState {
  checked: boolean;
  metaConnected: boolean;
  metaAccountSelected?: boolean;
  githubConnected?: boolean;
  opsRepoLinked?: boolean;
  llmProviders: string[];
  detail?: string;
}

type InitAuthPrismaClient = {
  oAuthToken: {
    findMany: (args: unknown) => Promise<Array<{ provider: string; metadata?: unknown; accessTokenCiphertext: string }>>;
  };
  workspace: {
    findFirst: (args: unknown) => Promise<{
      opsRepoId: string | null;
      defaultAdAccountId?: string | null;
    } | null>;
  };
  $disconnect: () => Promise<void>;
};

interface ScaffoldOptions {
  projectName?: string;
  language?: AddroidLanguagePreference;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    streamOutput?: boolean;
  }
) => CommandResult;

export async function runInit(
  args: string[],
  overrides: InitCommandOverrides = {}
): Promise<number> {
  let opts: InitOptions;
  try {
    opts = parseInitArgs(args);
  } catch (err) {
    process.stderr.write(`[addroid init] ${(err as Error).message}\n\n`);
    printInitHelp();
    return 2;
  }
  if (opts.help) {
    printInitHelp();
    return 0;
  }

  const env = overrides.env ?? process.env;
  const isTTY =
    overrides.isTTY ??
    (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && env.CI !== "true");
  const interactive = opts.interactive ?? isTTY;

  if (!interactive && hasReauthIntent(opts)) {
    process.stderr.write(
      "[addroid init] --reauth-* は対話入力またはブラウザ認証を伴います。端末から `addroid connect meta|github|ai` を実行してください。\n"
    );
    return 2;
  }

  if (interactive && shouldRunReauthOnly(opts)) {
    return runReauthOnly(opts, overrides);
  }

  if (interactive) {
    if (await shouldShortCircuitAlreadyInitialized(opts, overrides, env)) {
      const result = await safeScaffoldAddroid({
        projectName: opts.projectName,
        language: opts.language,
      }, env);
      if (!result) return 1;
      const auth = await readInitAuthState(env, overrides);
      const cliLinkLines = await maybeEnsureCliCommand({
        env,
        runner: overrides.runCommand ?? defaultRunCommand,
        confirm: overrides.confirm ?? defaultConfirm,
        skip: opts.skipLinkCli,
      });
      const metaCliSetupLines: string[] = [];
      const serviceSetupLines = await maybeInstallServiceAfterInit(opts, overrides);
      await printAlreadyInitializedResult(result, auth, cliLinkLines, metaCliSetupLines, serviceSetupLines);
      return 0;
    }
    return runInteractiveInit(opts, overrides);
  }

  if (shouldRunNonInteractiveSetup(opts)) {
    return runNonInteractiveSetup(opts, overrides);
  }

  const result = await safeScaffoldAddroid({
    projectName: opts.projectName,
    language: opts.language,
  }, env);
  if (!result) return 1;
  const cliLinkLines = await maybeEnsureCliCommand({
    env,
    runner: overrides.runCommand ?? defaultRunCommand,
    confirm: overrides.confirm ?? defaultConfirm,
    skip: opts.skipLinkCli,
  });
  printScaffoldResult(result, cliLinkLines);
  return 0;
}

function shouldRunNonInteractiveSetup(opts: InitOptions): boolean {
  return Boolean(
    opts.yes ||
      opts.installDeps ||
      opts.dbPush ||
      opts.projectName ||
      opts.databaseUrl ||
      opts.envFile ||
      opts.language ||
      opts.mockIntegrations ||
      opts.force
  );
}

function hasReauthIntent(opts: InitOptions): boolean {
  return opts.reauthMeta || opts.reauthGithub || opts.reauthLlm;
}

function shouldRunReauthOnly(opts: InitOptions): boolean {
  return Boolean(
    hasReauthIntent(opts) &&
      !opts.yes &&
      !opts.installDeps &&
      !opts.dbPush &&
      !opts.projectName &&
      !opts.databaseUrl &&
      !opts.language &&
      !opts.mockIntegrations &&
      !opts.force
  );
}

function hasSetupIntent(opts: InitOptions): boolean {
  return Boolean(
    opts.yes ||
      opts.installDeps ||
      opts.dbPush ||
      opts.projectName ||
      opts.databaseUrl ||
      opts.envFile ||
      opts.language ||
      opts.mockIntegrations ||
      opts.force ||
      hasReauthIntent(opts)
  );
}

async function shouldShortCircuitAlreadyInitialized(
  opts: InitOptions,
  overrides: InitCommandOverrides,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (opts.interactive === true || hasSetupIntent(opts)) return false;
  if (!env.DATABASE_URL || !env.ENCRYPTION_KEY) return false;
  let existing: AddroidConfig | null = null;
  try {
    existing = await readAddroidConfig(env);
  } catch {
    return false;
  }
  if (!existing) return false;
  const auth = await readInitAuthState(env, overrides);
  return (
    auth.checked &&
    auth.metaConnected &&
    auth.githubConnected !== false &&
    auth.opsRepoLinked !== false &&
    auth.llmProviders.length > 0
  );
}

async function runNonInteractiveSetup(
  opts: InitOptions,
  overrides: InitCommandOverrides
): Promise<number> {
  const env = overrides.env ?? process.env;
  const runner = overrides.runCommand ?? defaultRunCommand;
  const lines: string[] = ["[addroid init]", "", "Running non-interactive setup."];

  if (!opts.skipDeps && opts.installDeps) {
    process.stdout.write(lines.join("\n") + "\n");
    lines.length = 0;
    const dep = await setupDependencies({ opts, env, runner });
    lines.push(...dep.lines);
    if (!dep.ok) {
      process.stdout.write(lines.join("\n") + "\n");
      return 1;
    }
  }
  const databaseUrl = resolveInitDatabaseUrl(opts, env, overrides);
  const key = env.ENCRYPTION_KEY ?? generateEncryptionKey(overrides);
  const envResult = await ensureEnvFile({
    env,
    envFile: opts.envFile,
    databaseUrl,
    encryptionKey: key,
    mockIntegrations: opts.mockIntegrations,
    forcePlaceholders: true,
  });
  lines.push(...formatEnvResult(envResult));

  const scaffold = await safeScaffoldAddroid({
    projectName: opts.projectName,
    language: opts.language,
  }, env);
  if (!scaffold) return 1;
  lines.push(...formatScaffoldResult(scaffold));
  lines.push(
    ...(await maybeEnsureCliCommand({
      env,
      runner,
      confirm: overrides.confirm ?? defaultConfirm,
      skip: opts.skipLinkCli,
    }))
  );

  if (!opts.skipDbCreate && opts.yes) {
    const db = maybeCreateLocalDatabase(databaseUrl, runner, env);
    lines.push(...formatCommandOutcome("local database", db));
  }
  if (opts.dbPush && !opts.skipDbPush) {
    const dbPush = runPrismaSetup(runner, env);
    lines.push(...formatCommandOutcome("Prisma schema", dbPush));
    if (!dbPush.ok) {
      process.stdout.write(lines.join("\n") + "\n");
      return 1;
    }
  }

  if (opts.mockIntegrations) {
    lines.push("");
    lines.push("Mock integrations are enabled in .env. Remove mock flags before real Meta / GitHub connections.");
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. addroid status");
  lines.push("  2. Meta App に Privacy Policy URL を設定し、Live / 公開にする");
  lines.push("  3. Meta Access Token を用意");
  lines.push("  4. addroid connect meta                 # token 入力 + Ad Account 選択");
  lines.push("  5. addroid connect ai                   # Codex app-server / OpenAI / Claude を選択");
  lines.push("  6. addroid connect github               # GitHub 認証 + ops repo 作成");
  lines.push("  7. addroid start");
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return 0;
}

async function runReauthOnly(
  opts: InitOptions,
  overrides: InitCommandOverrides
): Promise<number> {
  const env = overrides.env ?? process.env;
  const prompt = overrides.prompt ?? defaultPrompt;
  const selectOption =
    overrides.selectOption ??
    (overrides.prompt ? buildPromptSelect(prompt) : defaultSelectOption);
  const runAuthCommand =
    overrides.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
  const out: string[] = [
    "[addroid init]",
    "",
    "指定された接続だけ再認証します。config / secrets / .env の初期セットアップはやり直しません。",
    "次回からは `addroid connect meta` / `addroid connect github` / `addroid connect ai` を使えます。",
    "",
  ];
  const flush = () => {
    if (out.length === 0) return;
    process.stdout.write(out.join("\n") + "\n");
    out.length = 0;
  };

  if (opts.reauthMeta) {
    out.push("Meta setup:");
    out.push("  `addroid connect meta` と同じ Access Token 登録 + Ad Account 選択を実行します。");
    flush();
    const code = await withRuntimeEnv(env, () => runAuthCommand(["meta"]));
    if (code !== 0) return code;
  }

  if (opts.reauthLlm) {
    const configured = await maybeConfigureLLMProvider({
      prompt,
      selectOption,
      out,
      assumeYes: false,
      runAuthCommand: overrides.runAuthCommand,
      runner: overrides.runCommand ?? defaultRunCommand,
      confirm: overrides.confirm ?? defaultConfirm,
      env,
      envFile: opts.envFile,
    });
    flush();
    if (configured === "error") return 1;
  }

  if (opts.reauthGithub) {
    out.push("");
    out.push("GitHub setup:");
    out.push("  `addroid connect github` と同じ GitHub 認証 + ops repo 確認を実行します。");
    flush();
    const code = await withRuntimeEnv(env, () => runAuthCommand(["github"]));
    if (code !== 0) return code;
  }

  out.push("");
  out.push("Ready.");
  out.push("  1. addroid status");
  flush();
  return 0;
}

async function runInteractiveInit(
  opts: InitOptions,
  overrides: InitCommandOverrides
): Promise<number> {
  const env = overrides.env ?? process.env;
  const runner = overrides.runCommand ?? defaultRunCommand;
  const prompt = overrides.prompt ?? defaultPrompt;
  const confirm = overrides.confirm ?? defaultConfirm;
  const selectOption =
    overrides.selectOption ??
    (overrides.prompt ? buildPromptSelect(prompt) : defaultSelectOption);
  const lines: string[] = [
    "[addroid init]",
    "",
    "AdDroid の初期セットアップを開始します。",
    "既存の config / secrets / .env は破壊せず、不足している値だけ作成します。",
    "",
  ];

  if (!opts.skipDeps) {
    const checks = [
      checkPlatform(),
      checkGithubCli(),
      checkPostgresVersion(),
    ];
    lines.push("Dependency check:");
    for (const c of checks) lines.push(formatCheck(c));
    lines.push("");
    const initialAuth = await readInitAuthState(env, overrides);
    lines.push("Integration check:");
    lines.push(...formatIntegrationCheck(initialAuth, opts));
    const failing = checks.filter(needsSetupAction);
    if (failing.length > 0) {
      lines.push("");
      lines.push("不足している依存があります。");
      for (const c of failing) {
        if (c.hint) lines.push(`  - ${c.name}: ${c.hint}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      lines.length = 0;
      const shouldInstall =
        opts.installDeps || opts.yes || (await confirm("不足依存を一つずつ確認してセットアップしますか?", true));
      if (shouldInstall) {
        const installResults = await installMissingDependencies(failing, runner, env, {
          assumeYes: opts.yes || opts.installDeps,
          confirm,
        });
        for (const r of installResults) {
          process.stdout.write(formatCommandOutcome(r.label, r.outcome).join("\n") + "\n");
          if (!r.outcome.ok) {
            process.stderr.write(
              `[addroid init] ${r.label} の自動セットアップに失敗しました。表示されたコマンドで手動解決してから再実行してください。\n`
            );
            return 1;
          }
        }
      }
    } else {
      lines.push("");
    }
  } else {
    const initialAuth = await readInitAuthState(env, overrides);
    lines.push("Integration check:");
    lines.push(...formatIntegrationCheck(initialAuth, opts));
    lines.push("");
  }

  let existing: AddroidConfig | null = null;
  try {
    existing = await readAddroidConfig(env);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      process.stderr.write(formatConfigParseError(err));
      return 1;
    }
    throw err;
  }

  if (lines.length > 0) {
    process.stdout.write(lines.join("\n") + "\n");
    lines.length = 0;
  }

  const cliLinkLines = await maybeEnsureCliCommand({
    env,
    runner,
    confirm,
    skip: opts.skipLinkCli,
  });
  if (cliLinkLines.length > 0) {
    process.stdout.write(cliLinkLines.join("\n") + "\n");
  }

  const projectName =
    opts.projectName ??
    (await prompt(
      "この AdDroid インスタンスの名前",
      existing?.workspace.displayName ?? "addroid"
    ));
  const databaseUrl =
    opts.databaseUrl ??
    (await prompt("DATABASE_URL", resolveInitDatabaseUrl(opts, env, overrides)));
  const encryptionKey = env.ENCRYPTION_KEY ?? generateEncryptionKey(overrides);
  const envResult = await ensureEnvFile({
    env,
    envFile: opts.envFile,
    databaseUrl,
    encryptionKey,
    mockIntegrations: opts.mockIntegrations,
    forcePlaceholders: true,
  });
  const scaffold = await safeScaffoldAddroid({ projectName, language: opts.language }, env);
  if (!scaffold) return 1;

  const out: string[] = [];
  out.push(...formatEnvResult(envResult));
  if (opts.mockIntegrations) {
    out.push("  mock mode     : enabled (remove ADDROID_*_MOCK before real Meta / GitHub connections)");
  }
  out.push(...formatScaffoldResult(scaffold));

  const shouldCreateDb =
    !opts.skipDbCreate &&
    isDefaultLocalDatabase(databaseUrl) &&
    (opts.yes || (await confirm("ローカル PostgreSQL に addroid DB / role を作成しますか?", true)));
  if (shouldCreateDb) {
    const db = maybeCreateLocalDatabase(databaseUrl, runner, env);
    out.push(...formatCommandOutcome("local database", db));
    if (!db.ok) {
      out.push("  hint: PostgreSQL を起動し、権限のあるユーザーで再実行してください。");
    }
  }

  const shouldPush =
    !opts.skipDbPush &&
    (opts.dbPush || opts.yes || (await confirm("Prisma schema を DB に反映しますか?", true)));
  if (shouldPush) {
    const dbPush = runPrismaSetup(runner, env);
    out.push(...formatCommandOutcome("Prisma schema", dbPush));
    if (!dbPush.ok) {
      process.stdout.write(out.join("\n") + "\n");
      return 1;
    }
  }

  let metaCredentialReady = opts.mockIntegrations;
  let llmCredentialReady = opts.mockIntegrations;
  let githubCredentialReady = opts.mockIntegrations;
  let opsRepoReady = opts.mockIntegrations;
  if (!opts.mockIntegrations) {
    const auth = await readInitAuthState(env, overrides);
    if (auth.checked && auth.metaConnected && !opts.force && !opts.reauthMeta) {
      metaCredentialReady = true;
      out.push("");
      out.push("Meta Access Token setup:");
      out.push("  Meta Token    : already configured");
      out.push("                  再認証する場合は `addroid connect meta` を実行してください。");
    } else {
      const configured = await maybeConfigureMetaAccessToken({
        out,
        assumeYes: opts.yes,
        confirm,
      });
      if (configured && !opts.yes) {
        process.stdout.write(out.join("\n") + "\n");
        out.length = 0;
        const runAuthCommand =
          overrides.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
        const code = await withRuntimeEnv(env, () => runAuthCommand(["meta"]));
        out.push(`  Meta Token    : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
        metaCredentialReady = code === 0;
        if (code !== 0) {
          out.push("                  Meta Access Token は実利用に必須です。token と DB 設定を確認し、`addroid connect meta` を再実行してください。");
          process.stdout.write(out.join("\n") + "\n");
          return 1;
        }
      }
    }

    let llmConfigured: CredentialSetupResult = "configured";
    if (auth.checked && auth.llmProviders.length > 0 && !opts.force && !opts.reauthLlm) {
      llmCredentialReady = true;
      out.push("");
      out.push("LLM Provider setup:");
      out.push(`  LLM Provider  : already configured (${auth.llmProviders.join(", ")})`);
      out.push("                  再認証する場合は `addroid connect ai` で provider を選び直してください。");
    } else {
      llmConfigured = await maybeConfigureLLMProvider({
        prompt,
        selectOption,
        out,
        assumeYes: opts.yes,
        runAuthCommand: overrides.runAuthCommand,
        runner,
        confirm,
        env,
        envFile: opts.envFile,
      });
      llmCredentialReady = llmConfigured === "configured" && !opts.yes;
    }
    if (llmConfigured === "error") {
      process.stdout.write(out.join("\n") + "\n");
      return 1;
    }

    const githubAlreadyReady =
      auth.checked && auth.githubConnected !== false && auth.opsRepoLinked !== false;
    if (githubAlreadyReady && !opts.force && !opts.reauthGithub) {
      githubCredentialReady = true;
      opsRepoReady = true;
      out.push("");
      out.push("GitHub setup:");
      out.push("  GitHub       : already configured");
      out.push("                 ops repository は既に workspace に紐付いています。");
    } else {
      out.push("");
      out.push("GitHub setup:");
      out.push("  実際の入稿には ops repository が必要です。");
      out.push("  このまま GitHub Device Flow 認証に進み、認証後に ops repository を自動作成します。");
      const githubOAuth = await resolveGithubClientIdForInit(env);
      if (githubOAuth.clientId) {
        out.push(`  GitHub OAuth : client id configured (${githubOAuth.source})`);
        if (githubOAuth.clientSecretPresent) {
          out.push("                 Web UI OAuth Code Flow 用 clientSecret も設定済みです。");
        } else {
          out.push("                 CLI Device Flow はこのまま実行できます。");
          out.push("                 Web UI OAuth Code Flow も使う場合は github.oauth.clientSecret を secrets.local.yaml に追加してください。");
        }
      } else {
        out.push("  GitHub OAuth : client id 未設定のため GitHub CLI のブラウザ認証を使用します。");
        out.push("                 GitHub CLI が未インストールの場合は `brew install gh` 後に再実行してください。");
      }
      process.stdout.write(out.join("\n") + "\n");
      out.length = 0;
      const shouldConfigureGithub = await confirm("GitHub 認証と ops repository 作成を今設定しますか?", true);
      if (!shouldConfigureGithub) {
        out.push("  GitHub       : skipped");
        out.push("                 後で `addroid connect github` を実行してください。");
      } else {
        const runAuthCommand =
          overrides.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
        const authArgs = githubOAuth.clientId
          ? ["github", "--client-id", githubOAuth.clientId]
          : ["github"];
        const code = await withRuntimeEnv(env, () => runAuthCommand(authArgs));
        out.push(`  GitHub       : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
        githubCredentialReady = code === 0;
        opsRepoReady = code === 0;
        if (code !== 0) {
          out.push("                 実際の入稿には GitHub 認証と ops repository が必須です。`addroid connect github` を再実行してください。");
          process.stdout.write(out.join("\n") + "\n");
          return 1;
        }
      }
    }
  }

  const serviceSetupLines = await maybeInstallServiceAfterInit(opts, overrides);
  if (serviceSetupLines.length > 0) {
    out.push("");
    out.push(...serviceSetupLines);
  }
  out.push("");
  out.push("Ready.");
  out.push(...formatReadySteps({
    metaCredentialReady,
    llmCredentialReady,
    githubCredentialReady,
    opsRepoReady,
  }));
  out.push("");
  process.stdout.write(out.join("\n"));
  if (shouldAutoStartChatAfterInit(opts, overrides, { llmCredentialReady })) {
    const { runChatCommand } = await import("./chat.js");
    return await runChatCommand([], { env });
  }
  return 0;
}

function shouldAutoStartChatAfterInit(
  opts: InitOptions,
  overrides: InitCommandOverrides,
  state: { llmCredentialReady: boolean }
): boolean {
  if (!state.llmCredentialReady) return false;
  if (opts.noChat || opts.yes || opts.mockIntegrations) return false;
  if (overrides.isTTY === false) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function maybeInstallServiceAfterInit(
  opts: InitOptions,
  overrides: InitCommandOverrides
): Promise<string[]> {
  if (opts.noService || opts.yes || opts.mockIntegrations) return [];
  if (overrides.isTTY === false) return [];
  if (!process.stdin.isTTY || !process.stdout.isTTY) return [];
  try {
    const status = await installAddroidService();
    return [
      "常駐サービス:",
      ...formatServiceStatus(status),
      "  note          : 以後は macOS / Linux / WSL2 のログイン時に自動起動します。",
    ];
  } catch (err) {
    return [
      "常駐サービス:",
      `  service       : install skipped (${(err as Error).message})`,
      "  hint          : 後で `addroid start` を実行すると常駐サービスを作成・起動できます。",
    ];
  }
}

function formatReadySteps(opts: {
  metaCredentialReady: boolean;
  llmCredentialReady: boolean;
  githubCredentialReady: boolean;
  opsRepoReady: boolean;
}): string[] {
  const lines = formatCommonCommandGuide();
  const steps: string[] = [];
  if (!opts.metaCredentialReady) {
    steps.push("addroid connect meta                 # Meta Access Token 入力 + Ad Account 選択");
  }
  if (!opts.llmCredentialReady) {
    steps.push("addroid connect ai                   # Codex app-server / OpenAI / Claude を選択");
  }
  if (!opts.githubCredentialReady || !opts.opsRepoReady) {
    steps.push("addroid connect github               # GitHub 認証 + ops repo 作成");
  }
  if (steps.length > 0) {
    lines.push("");
    lines.push("未完了の接続:");
    lines.push(...steps.map((step) => `  ${step}`));
  }
  return lines;
}

function formatCommonCommandGuide(): string[] {
  return [
    "よく使うコマンド:",
    "  addroid chat       # チャットで日次レポート、予算確認、改善提案、入稿チェックを依頼",
    "  addroid start      # 常駐サービスを起動・修復",
    "  addroid open       # Web UI をブラウザで開く",
    "  addroid status     # 接続状態と起動状態を確認",
    "  addroid report     # 日次レポートを今すぐ作成",
    "  addroid submit     # 入稿ファイルを検証し、反映前の変更予定を確認",
    "  addroid account    # 利用する Meta 広告アカウントを確認・選択",
    "  addroid schedule   # 定期実行タスクを確認・設定",
  ];
}

async function maybeEnsureCliCommand(opts: {
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  confirm: ConfirmFn;
  skip: boolean;
}): Promise<string[]> {
  if (opts.skip) {
    return [
      "CLI command setup:",
      "  addroid       : skipped (--skip-link-cli)",
      "                  後で `npm run addroid -- init` を再実行すると `addroid status` の形で使えます。",
      "",
    ];
  }

  void opts.runner;
  void opts.confirm;

  const paths = await ensureAddroidPaths(opts.env);
  const result = await ensureAddroidCommandLink(paths, opts.env);
  if (result.skippedReason) {
    return [
      "CLI command setup:",
      `  addroid       : skipped (${result.skippedReason})`,
      "                  この repository root では `npm run addroid -- <command>` も使えます。",
      "",
    ];
  }

  const lines = [
    "CLI command setup:",
    `  addroid       : ${result.wrote ? "created/updated" : "available"} (${result.commandPath})`,
    `  addroid-cli   : ${result.wrote ? "created/updated" : "available"} (${path.join(result.binDir, "addroid-cli")})`,
  ];
  if (result.pathAvailable) {
    lines.push("                  current shell can run `addroid <command>` directly.");
  } else {
    lines.push("                  open a new terminal to use `addroid <command>` directly.");
    if (result.profilePath) {
      lines.push(
        `                  PATH profile: ${result.profilePath} ${
          result.profileUpdated ? "(updated)" : "(already configured)"
        }`
      );
    } else if (result.profileSkippedReason) {
      lines.push(`                  PATH profile: not modified (${result.profileSkippedReason})`);
    }
    if (result.exportLine) {
      lines.push(`                  current shell: ${result.exportLine}`);
    }
  }
  lines.push("");
  return lines;
}

interface CommandLinkResult {
  binDir: string;
  commandPath: string;
  pathAvailable: boolean;
  wrote: boolean;
  skippedReason?: string;
  profilePath?: string;
  profileUpdated?: boolean;
  profileSkippedReason?: string;
  exportLine?: string;
}

async function ensureAddroidCommandLink(
  paths: Awaited<ReturnType<typeof ensureAddroidPaths>>,
  env: NodeJS.ProcessEnv
): Promise<CommandLinkResult> {
  const binDir = resolveAddroidCommandBinDir(paths, env);
  const commandPath = path.join(binDir, "addroid");
  const aliasPath = path.join(binDir, "addroid-cli");
  const pathAvailable = isPathEntryAvailable(binDir, env);
  const target = await resolveCurrentCliLauncherPath();
  const result: CommandLinkResult = {
    binDir,
    commandPath,
    pathAvailable,
    wrote: false,
  };

  if (!target) {
    result.skippedReason = "CLI launcher not found";
    return result;
  }

  await fs.mkdir(binDir, { recursive: true });
  const marker = "# Generated by addroid init.";
  const wrapper =
    "#!/bin/sh\n" +
    `${marker} Re-run init to refresh this repository link.\n` +
    `exec node ${shellQuote(target)} "$@"\n`;

  const primary = await writeCommandWrapper(commandPath, wrapper, marker, target, binDir);
  if (primary.skippedReason) {
    result.skippedReason = primary.skippedReason;
    return maybeUpdatePathProfile(result, env);
  }
  const alias = await writeCommandWrapper(aliasPath, wrapper, marker, target, binDir);
  result.wrote = primary.wrote || alias.wrote;
  return maybeUpdatePathProfile(result, env);
}

async function writeCommandWrapper(
  commandPath: string,
  wrapper: string,
  marker: string,
  target: string,
  binDir: string
): Promise<{ wrote: boolean; skippedReason?: string }> {
  let existing = "";
  try {
    const stat = await fs.lstat(commandPath);
    if (stat.isSymbolicLink()) {
      const linked = await fs.readlink(commandPath);
      if (path.resolve(binDir, linked) === target) {
        await fs.unlink(commandPath);
      } else {
        return { wrote: false, skippedReason: `existing ${path.basename(commandPath)} symlink points to ${linked}` };
      }
    } else {
      existing = await fs.readFile(commandPath, "utf8");
      if (existing && existing !== wrapper && !existing.includes(marker)) {
        return {
          wrote: false,
          skippedReason: `existing ${path.basename(commandPath)} command was not created by init`,
        };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing !== wrapper) {
    await fs.writeFile(commandPath, wrapper, { encoding: "utf8", mode: 0o755 });
    await fs.chmod(commandPath, 0o755).catch(() => undefined);
    return { wrote: true };
  }
  await fs.chmod(commandPath, 0o755).catch(() => undefined);
  return { wrote: false };
}

function resolveAddroidCommandBinDir(
  paths: Awaited<ReturnType<typeof ensureAddroidPaths>>,
  env: NodeJS.ProcessEnv
): string {
  const override = env.ADDROID_COMMAND_BIN_DIR?.trim();
  if (override) return path.resolve(override);
  if (env.ADDROID_HOME?.trim()) return path.join(paths.home, "bin");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const localBin = path.join(home, ".local", "bin");
  if (isPathEntryAvailable(localBin, env)) return localBin;
  return path.join(paths.home, "bin");
}

function isPathEntryAvailable(binDir: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = path.resolve(binDir);
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === normalized);
}

async function resolveCurrentCliLauncherPath(): Promise<string | null> {
  const candidates: string[] = [];
  try {
    candidates.push(path.join(resolveRepoRoot(), "apps", "cli", "bin", "addroid.cjs"));
  } catch {
    /* global package install: fall back to import location */
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    candidates.push(path.join(dir, "bin", "addroid.cjs"));
    candidates.push(path.join(dir, "..", "bin", "addroid.cjs"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

async function maybeUpdatePathProfile(
  result: CommandLinkResult,
  env: NodeJS.ProcessEnv
): Promise<CommandLinkResult> {
  if (result.skippedReason) return result;
  result.exportLine = `export PATH="${pathProfileEntry(result.binDir, env)}:$PATH"`;
  if (result.pathAvailable) {
    result.profileSkippedReason = "already on PATH";
    return result;
  }
  if (env.CI === "true") {
    result.profileSkippedReason = "CI=true";
    return result;
  }
  if (env.ADDROID_HOME?.trim()) {
    result.profileSkippedReason = "ADDROID_HOME is custom; profile not modified automatically";
    return result;
  }
  if (env.ADDROID_SKIP_PATH_PROFILE === "1") {
    result.profileSkippedReason = "ADDROID_SKIP_PATH_PROFILE=1";
    return result;
  }
  const profilePath = resolveShellProfilePath(env);
  if (!profilePath) {
    result.profileSkippedReason = "shell profile not detected";
    return result;
  }
  result.profilePath = profilePath;
  const line = result.exportLine;
  let current = "";
  try {
    current = await fs.readFile(profilePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      result.profileSkippedReason = `profile read failed: ${(err as Error).message}`;
      return result;
    }
  }
  if (current.includes(result.binDir) || current.includes(pathProfileEntry(result.binDir, env))) {
    result.profileUpdated = false;
    return result;
  }
  const next =
    current.replace(/\n*$/, "\n") +
    "\n# Added by AdDroid OSS init: make `addroid` available as a command.\n" +
    `${line}\n`;
  try {
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(profilePath, next, "utf8");
    result.profileUpdated = true;
  } catch (err) {
    result.profileSkippedReason = `profile update failed: ${(err as Error).message}`;
  }
  return result;
}

function resolveShellProfilePath(env: NodeJS.ProcessEnv): string | null {
  const override = env.ADDROID_SHELL_PROFILE?.trim();
  if (override) return path.resolve(override);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  if (!home) return null;
  const shell = path.basename(env.SHELL ?? "");
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") return path.join(home, ".bashrc");
  if (process.platform === "darwin") return path.join(home, ".zshrc");
  return path.join(home, ".profile");
}

function pathProfileEntry(binDir: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const absolute = path.resolve(binDir);
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  if (absolute.startsWith(prefix)) {
    return `$HOME/${absolute.slice(prefix.length).split(path.sep).join("/")}`;
  }
  return absolute;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function maybeConfigureMetaAccessToken(opts: {
  out: string[];
  assumeYes: boolean;
  confirm: ConfirmFn;
}): Promise<boolean> {
  opts.out.push("");
  opts.out.push("Meta Access Token setup:");
  opts.out.push("  実際の Meta 広告アカウントを接続して Apply / Activate / レポート取得を行うには必須です。");
  opts.out.push("  AdDroid の標準設定は OAuth callback ではなく Access Token 入力方式です。");
  opts.out.push("  ローカル利用で HTTPS callback URL を用意する必要はありません。");
  opts.out.push("  本番入稿には、token 発行元 Meta App の Privacy Policy URL 設定と Live / 公開モードが必要です。");
  opts.out.push("  Meta Business Suite / Graph API Explorer 等で token を発行し、この後の入力欄に貼り付けます。");
  opts.out.push("  必要な権限の目安: ads_read, ads_management, business_management。");
  opts.out.push("  token 入力後、AdDroid が取得できる Ad Account を表示し、利用するアカウントを選択します。");
  opts.out.push("  入力値は ENCRYPTION_KEY で暗号化し、平文では保存しません。");
  if (!opts.assumeYes) {
    opts.out.push("  今設定する場合は、この後の非表示入力に token を貼り付けます。");
  }
  process.stdout.write(opts.out.join("\n") + "\n");
  opts.out.length = 0;

  if (opts.assumeYes) {
    opts.out.push("  Meta Token    : skipped (--yes では token 入力を省略)");
    opts.out.push("                  後で `addroid connect meta` を実行してください。");
    return false;
  }
  const shouldConfigure = await opts.confirm("Meta Access Token を今設定して Ad Account を選択しますか?", true);
  if (!shouldConfigure) {
    opts.out.push("  Meta Token    : skipped");
    opts.out.push("                  後で `addroid connect meta` を実行してください。");
    return false;
  }
  return true;
}

type CredentialSetupResult = "configured" | "skipped" | "error";

async function maybeConfigureLLMProvider(opts: {
  prompt: PromptFn;
  selectOption: SelectFn;
  out: string[];
  assumeYes: boolean;
  runAuthCommand?: (args: string[]) => Promise<number>;
  runner?: CommandRunner;
  confirm?: ConfirmFn;
  env: NodeJS.ProcessEnv;
  envFile?: string;
}): Promise<CredentialSetupResult> {
  if (opts.assumeYes) {
    opts.out.push("  LLM Provider  : skipped (--yes では API key / OAuth 入力を省略)");
    opts.out.push("                  実利用には LLM Provider が必須です。後で `addroid connect ai` を実行してください。");
    return "skipped";
  }
  opts.out.push("");
  opts.out.push("LLM Provider setup:");
  opts.out.push("  AI workflow / レポート生成 / 改善提案には LLM Provider が必須です。");
  opts.out.push("  Codex は local app-server を使います。OpenAI / Claude API key は ENCRYPTION_KEY で暗号化保存します。");
  process.stdout.write(opts.out.join("\n") + "\n");
  opts.out.length = 0;
  const choice = (
    await opts.selectOption(
      "LLM Provider",
      [
        {
          value: "openai-api-key",
          label: "OpenAI API key",
          description: "OpenAI の API key を暗号化保存して使います",
        },
        {
          value: "anthropic-api-key",
          label: "Anthropic API key",
          description: "Anthropic の API key を暗号化保存して使います",
        },
        {
          value: "codex-app-server",
          label: "Codex app-server",
          description: "Codex CLI / ChatGPT の認証状態を使います",
        },
        {
          value: "skip",
          label: "今はスキップ",
          description: "後で addroid connect ai を実行します",
        },
      ],
      "openai-api-key"
    )
  )
    .trim()
    .toLowerCase();

  if (choice === "skip" || choice === "none") {
    opts.out.push("  LLM Provider  : skipped");
    opts.out.push("                  実利用には LLM Provider が必須です。後で `addroid connect ai` を実行してください。");
    return "skipped";
  }
  if (choice === "codex-app-server" || choice === "codex") {
    let codexCheck = checkCodexCli();
    opts.out.push(`  ${formatCheck(codexCheck).trim()}`);
    if (codexCheck.state === "error") {
      if (opts.runner) {
        process.stdout.write(opts.out.join("\n") + "\n");
        opts.out.length = 0;
        const installResults = await installMissingDependencies([codexCheck], opts.runner, opts.env, {
          confirm: opts.confirm,
        });
        for (const r of installResults) {
          opts.out.push(...formatCommandOutcome(r.label, r.outcome));
          if (!r.outcome.ok) return "error";
        }
        codexCheck = checkCodexCli();
        opts.out.push(`  ${formatCheck(codexCheck).trim()}`);
      }
      if (codexCheck.state === "error") {
        if (codexCheck.hint) opts.out.push(`                  ${codexCheck.hint}`);
        opts.out.push("                  Codex app-server を使う場合だけ Codex CLI が必要です。");
        return "error";
      }
    }
    const codexEnv = await ensureCodexAppServerEnvConfig({
      env: opts.env,
      envFile: opts.envFile,
      out: opts.out,
    });
    if (!codexEnv) return "error";
    opts.out.push("  LLM Provider  : configuring Codex app-server");
    opts.out.push("                  Codex CLI のログイン状態を確認します。未ログインの場合はブラウザが開きます。");
    process.stdout.write(opts.out.join("\n") + "\n");
    opts.out.length = 0;
    const runAuthCommand =
      opts.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
    const code = await withRuntimeEnv(opts.env, () =>
      runAuthCommand(["llm", "--provider", "codex"])
    );
    opts.out.push(`  LLM Provider  : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
    if (code !== 0) {
      opts.out.push("                  実利用には LLM Provider が必須です。Codex CLI のログイン状態を確認し、`addroid connect ai --provider codex` を再実行してください。");
      return "error";
    }
    return "configured";
  }

  const provider =
    choice === "anthropic" || choice === "anthropic-api-key"
      ? "anthropic"
      : choice === "openai" || choice === "openai-api-key"
        ? "openai"
        : null;
  if (!provider) {
    opts.out.push(`  LLM Provider  : unknown choice (${choice})`);
    opts.out.push("                  openai-api-key / anthropic-api-key / codex-app-server のいずれかを選んでください。");
    return "error";
  }
  const defaultModel =
    provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
  const model = (await opts.prompt(`${provider} default model`, defaultModel)).trim() || defaultModel;
  opts.out.push(`  LLM Provider  : configuring ${provider} API key`);
  process.stdout.write(opts.out.join("\n") + "\n");
  opts.out.length = 0;
  const runAuthCommand =
    opts.runAuthCommand ?? (await import("./auth.js")).runAuthCommand;
  const code = await withRuntimeEnv(opts.env, () =>
    runAuthCommand(["llm", "--provider", provider, "--model", model])
  );
  opts.out.push(`  LLM Provider  : ${code === 0 ? "ok" : `skipped/error (exit ${code})`}`);
  if (code === 0 && provider === "openai") {
    opts.out.push("  Image Provider: OpenAI API key will also be used for GPT Image 2");
  }
  if (code === 0 && provider === "anthropic") {
    opts.out.push("  Image Provider: GPT Image 2 requires OpenAI API key or Codex app-server");
  }
  if (code !== 0) {
    opts.out.push(`                  実利用には LLM Provider が必須です。API key を確認し、\`addroid connect ai --provider ${provider}\` を再実行してください。`);
    return "error";
  }
  return "configured";
}

async function resolveGithubClientIdForInit(env: NodeJS.ProcessEnv): Promise<{
  clientId: string | null;
  source: string;
  clientSecretPresent: boolean;
}> {
  const fromEnv =
    env.ADDROID_GITHUB_CLIENT_ID?.trim() ||
    env.ADDROID_GITHUB_OAUTH_CLIENT_ID?.trim();
  if (fromEnv) {
    const secrets = await readLocalSecrets(env).catch(() => null);
    return {
      clientId: fromEnv,
      source: "env",
      clientSecretPresent: Boolean(secrets?.github?.oauth?.clientSecret),
    };
  }
  const secrets = await readLocalSecrets(env).catch(() => null);
  const clientId = secrets?.github?.oauth?.clientId?.trim() || null;
  return {
    clientId,
    source: "secrets.local.yaml",
    clientSecretPresent: Boolean(secrets?.github?.oauth?.clientSecret),
  };
}

async function ensureCodexAppServerEnvConfig(opts: {
  env: NodeJS.ProcessEnv;
  envFile?: string;
  out: string[];
}): Promise<boolean> {
  const requiredDefaults: Record<string, string> = {
    ADDROID_LLM_PROVIDER: "codex",
  };
  const result = await ensureAdditionalEnvValues({
    env: opts.env,
    envFile: opts.envFile,
    updates: requiredDefaults,
  });
  if (result.updated.length > 0 || result.kept.length > 0) {
    opts.out.push(
      `  Codex config  : ${result.path} ${result.wrote ? "(updated)" : "(unchanged)"}`
    );
    opts.out.push(
      `                  updated: ${result.updated.length > 0 ? result.updated.join(", ") : "none"}${
        result.kept.length > 0 ? `; kept existing: ${result.kept.join(", ")}` : ""
      }`
    );
  }
  return true;
}

interface ScaffoldResult {
  paths: Awaited<ReturnType<typeof ensureAddroidPaths>>;
  configPath: string;
  configWrote: boolean;
  secretsCreated: boolean;
}

async function scaffoldAddroid(
  opts: ScaffoldOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<ScaffoldResult> {
  const paths = await ensureAddroidPaths(env);

  let existing: AddroidConfig | null = null;
  try {
    existing = await readAddroidConfig(env);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      process.stderr.write(formatConfigParseError(err));
      throw new InitAbort();
    }
    throw err;
  }

  const next = mergeWithDefaults(existing, opts);
  const result = await writeAddroidConfig(next, env);

  const secretsCreated = await ensureSecretsStub(paths.secretsFile);
  return {
    paths,
    configPath: result.path,
    configWrote: result.wrote,
    secretsCreated,
  };
}

async function safeScaffoldAddroid(
  opts: ScaffoldOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<ScaffoldResult | null> {
  try {
    return await scaffoldAddroid(opts, env);
  } catch (err) {
    if (err instanceof InitAbort) return null;
    throw err;
  }
}

function mergeWithDefaults(
  existing: AddroidConfig | null,
  opts: ScaffoldOptions = {}
): AddroidConfig {
  const defaults = defaultAddroidConfig();
  const projectName = opts.projectName?.trim();
  const language = opts.language ?? existing?.ui?.language ?? defaults.ui.language;
  if (!existing) {
    if (!projectName && language === defaults.ui.language) return defaults;
    return AddroidConfigSchema.parse({
      ...defaults,
      ui: { language },
      workspace: {
        ...defaults.workspace,
        slug: projectName ? slugify(projectName) : defaults.workspace.slug,
        displayName: projectName || defaults.workspace.displayName,
      },
    });
  }
  // 既存値を尊重しつつ、database.urlRef は環境に応じて再評価する。
  const next: AddroidConfig = {
    version: 1,
    workspace: {
      slug: projectName ? slugify(projectName) : existing.workspace.slug,
      displayName: projectName || existing.workspace.displayName,
      // Regression fix: 既に config.yaml に書かれた mode は再 init で
      // 黙って戻さない。未指定 (旧スキーマ) は schema default の "proposal" に倒す。
      executionMode:
        existing.workspace.executionMode ?? defaults.workspace.executionMode,
    },
    ui: {
      language,
    },
    database: {
      // urlRef は env に追従させる (既存値は意図的に上書き)。
      // 例: 初回実行時に DATABASE_URL 未設定で ".env.local" が記録された後、
      // ユーザーが DATABASE_URL を export して再 init した場合、現在の env を
      // 反映して "(env)" に更新する。逆方向 ((env) → .env.local) も同様に追従する。
      urlRef: defaults.database.urlRef,
    },
    web: {
      hostname: existing.web?.hostname ?? defaults.web.hostname,
      port: existing.web?.port ?? defaults.web.port,
    },
    github: existing.github ?? {},
  };
  // 念のため再 validate (例外が出れば呼び出し側で fail)。
  return AddroidConfigSchema.parse(next);
}

class InitAbort extends Error {}

async function ensureSecretsStub(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return false;
  } catch {
    /* not present */
  }
  await fs.writeFile(file, SECRETS_STUB, { encoding: "utf8", mode: 0o600 });
  return true;
}

interface EnvEnsureOptions {
  env: NodeJS.ProcessEnv;
  envFile?: string;
  databaseUrl: string;
  encryptionKey: string;
  mockIntegrations: boolean;
  forcePlaceholders: boolean;
}

interface EnvEnsureResult {
  path: string;
  wrote: boolean;
  updated: string[];
  kept: string[];
}

async function ensureEnvFile(opts: EnvEnsureOptions): Promise<EnvEnsureResult> {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : resolveDefaultEnvFile();
  const updates: Record<string, string> = {
    DATABASE_URL: opts.databaseUrl,
    ENCRYPTION_KEY: opts.encryptionKey,
  };
  if (opts.mockIntegrations) {
    updates.ADDROID_GITHUB_OAUTH_MOCK = "1";
    updates.ADDROID_LLM_MOCK = "1";
  }

  let text = "";
  try {
    text = await fs.readFile(envFile, "utf8");
  } catch {
    text =
      "# AdDroid OSS local environment. Generated by `addroid init`.\n" +
      "# This file is gitignored. Do not commit secrets.\n";
  }

  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const updated: string[] = [];
  const kept: string[] = [];
  const keptValues = new Map<string, string>();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const key = match[2]!;
    if (!(key in updates)) return line;
    seen.add(key);
    const current = stripEnvQuotes(match[4] ?? "");
    if (!opts.forcePlaceholders && current.trim().length > 0) {
      kept.push(key);
      keptValues.set(key, current);
      return line;
    }
    if (current.trim().length > 0 && !isPlaceholderEnvValue(key, current)) {
      kept.push(key);
      keptValues.set(key, current);
      return line;
    }
    updated.push(key);
    return `${match[1]}${key}${match[3]}${quoteEnv(updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      if (next.length > 0 && next[next.length - 1] !== "") next.push("");
      next.push(`${key}=${quoteEnv(value)}`);
      updated.push(key);
    }
  }

  const finalText = next.join("\n").replace(/\n*$/, "\n");
  const wrote = finalText !== text;
  if (wrote) {
    await fs.mkdir(path.dirname(envFile), { recursive: true });
    await fs.writeFile(envFile, finalText, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(envFile, 0o600).catch(() => undefined);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!opts.env[key] || isPlaceholderEnvValue(key, opts.env[key]!)) {
      opts.env[key] = keptValues.get(key) ?? value;
    }
  }

  return { path: envFile, wrote, updated, kept };
}

async function ensureAdditionalEnvValues(opts: {
  env: NodeJS.ProcessEnv;
  envFile?: string;
  updates: Record<string, string>;
}): Promise<EnvEnsureResult> {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : resolveDefaultEnvFile();
  let text = "";
  try {
    text = await fs.readFile(envFile, "utf8");
  } catch {
    text =
      "# AdDroid OSS local environment. Generated by `addroid init`.\n" +
      "# This file is gitignored. Do not commit secrets.\n";
  }

  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const updated: string[] = [];
  const kept: string[] = [];
  const keptValues = new Map<string, string>();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const key = match[2]!;
    if (!(key in opts.updates)) return line;
    seen.add(key);
    const current = stripEnvQuotes(match[4] ?? "");
    if (current.trim().length > 0 && !isPlaceholderEnvValue(key, current)) {
      kept.push(key);
      keptValues.set(key, current);
      return line;
    }
    updated.push(key);
    return `${match[1]}${key}${match[3]}${quoteEnv(opts.updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(opts.updates)) {
    if (!seen.has(key)) {
      if (next.length > 0 && next[next.length - 1] !== "") next.push("");
      next.push(`${key}=${quoteEnv(value)}`);
      updated.push(key);
    }
  }

  const finalText = next.join("\n").replace(/\n*$/, "\n");
  const wrote = finalText !== text;
  if (wrote) {
    await fs.mkdir(path.dirname(envFile), { recursive: true });
    await fs.writeFile(envFile, finalText, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(envFile, 0o600).catch(() => undefined);
  }

  for (const [key, value] of Object.entries(opts.updates)) {
    if (!opts.env[key] || isPlaceholderEnvValue(key, opts.env[key]!)) {
      opts.env[key] = keptValues.get(key) ?? value;
    }
  }

  return { path: envFile, wrote, updated, kept };
}

async function forceUpdateEnvValues(opts: {
  env: NodeJS.ProcessEnv;
  envFile?: string;
  updates: Record<string, string>;
}): Promise<EnvEnsureResult> {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : resolveDefaultEnvFile();
  let text = "";
  try {
    text = await fs.readFile(envFile, "utf8");
  } catch {
    text =
      "# AdDroid OSS local environment. Generated by `addroid init`.\n" +
      "# This file is gitignored. Do not commit secrets.\n";
  }

  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const updated: string[] = [];
  const kept: string[] = [];
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const key = match[2]!;
    if (!(key in opts.updates)) return line;
    seen.add(key);
    const desired = opts.updates[key]!;
    const current = stripEnvQuotes(match[4] ?? "");
    if (current === desired) {
      kept.push(key);
      return line;
    }
    updated.push(key);
    return `${match[1]}${key}${match[3]}${quoteEnv(desired)}`;
  });

  for (const [key, value] of Object.entries(opts.updates)) {
    if (!seen.has(key)) {
      if (next.length > 0 && next[next.length - 1] !== "") next.push("");
      next.push(`${key}=${quoteEnv(value)}`);
      updated.push(key);
    }
  }

  const finalText = next.join("\n").replace(/\n*$/, "\n");
  const wrote = finalText !== text;
  if (wrote) {
    await fs.mkdir(path.dirname(envFile), { recursive: true });
    await fs.writeFile(envFile, finalText, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(envFile, 0o600).catch(() => undefined);
  }
  for (const [key, value] of Object.entries(opts.updates)) opts.env[key] = value;
  return { path: envFile, wrote, updated, kept };
}

async function readInitAuthState(
  env: NodeJS.ProcessEnv,
  overrides: InitCommandOverrides
): Promise<InitAuthState> {
  if (overrides.readAuthState) return await overrides.readAuthState(env);
  if (!env.DATABASE_URL || !env.ENCRYPTION_KEY) {
    return {
      checked: false,
      metaConnected: false,
      githubConnected: false,
      opsRepoLinked: false,
      llmProviders: [],
      detail: "DATABASE_URL or ENCRYPTION_KEY is not configured",
    };
  }
  let prisma: InitAuthPrismaClient | null = null;
  try {
    const imported = (await import("@addroid/db")) as {
      prisma: InitAuthPrismaClient;
    };
    prisma = imported.prisma;
    const rows = await prisma.oAuthToken.findMany({
      where: {
        provider: {
          in: ["meta", "github", "codex", "openai", "anthropic"],
        },
      },
      select: {
        provider: true,
        metadata: true,
        accessTokenCiphertext: true,
      },
      orderBy: {
        connectedAt: "desc",
      },
    });
    const config = await readAddroidConfig(env).catch(() => null);
    const currentWs =
      (config
        ? await prisma.workspace.findFirst({
            where: { slug: config.workspace.slug },
            select: { opsRepoId: true, defaultAdAccountId: true },
          })
        : null);
    const fallbackAccountWs = await prisma.workspace.findFirst({
      where: { defaultAdAccountId: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { opsRepoId: true, defaultAdAccountId: true },
    });
    const fallbackOpsRepoWs = await prisma.workspace.findFirst({
      where: { opsRepoId: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { opsRepoId: true, defaultAdAccountId: true },
    });
    const fallbackLatestWs = await prisma.workspace.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { opsRepoId: true, defaultAdAccountId: true },
      });
    const accountWs =
      currentWs?.defaultAdAccountId ? currentWs : fallbackAccountWs ?? fallbackLatestWs;
    const opsRepoWs =
      currentWs?.opsRepoId ? currentWs : fallbackOpsRepoWs ?? fallbackLatestWs;
    const crypto = getCryptoBoundary(env);
    const validCredentialProviders = Array.from(
      new Set(
        rows
          .filter((r) => canDecryptCredential(crypto, r.accessTokenCiphertext))
          .map((r) => r.provider)
      )
    );
    const dbLlmProviders = Array.from(
      new Set(
        rows
          .filter((r) => r.provider === "codex" || r.provider === "openai" || r.provider === "anthropic")
          .filter((r) => canDecryptCredential(crypto, r.accessTokenCiphertext))
          .filter((r) => hasLLMDefaultModel(r.metadata))
          .map((r) => r.provider)
      )
    );
    const codexAppServerConnected = await detectCodexAppServerConnection(env);
    const llmProviders = codexAppServerConnected
      ? Array.from(new Set(["codex", ...dbLlmProviders]))
      : dbLlmProviders;
    return {
      checked: true,
      metaConnected: validCredentialProviders.includes("meta"),
      metaAccountSelected: Boolean(accountWs?.defaultAdAccountId),
      githubConnected: validCredentialProviders.includes("github"),
      opsRepoLinked: Boolean(opsRepoWs?.opsRepoId),
      llmProviders,
    };
  } catch (err) {
    return {
      checked: false,
      metaConnected: false,
      githubConnected: false,
      opsRepoLinked: false,
      llmProviders: [],
      detail: (err as Error).message,
    };
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

function canDecryptCredential(
  crypto: ReturnType<typeof getCryptoBoundary>,
  ciphertext: string
): boolean {
  try {
    crypto.decrypt(ciphertext);
    return true;
  } catch {
    return false;
  }
}

function hasLLMDefaultModel(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const value = (metadata as Record<string, unknown>)["defaultModel"];
  return typeof value === "string" && value.trim().length > 0;
}

async function detectCodexAppServerConnection(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.ADDROID_LLM_PROVIDER && env.ADDROID_LLM_PROVIDER.trim().toLowerCase() !== "codex") {
    return false;
  }
  try {
    const { CodexAppServerLLMProvider } = await import("@addroid/llm-provider");
    const provider = new CodexAppServerLLMProvider({
      externalServerUrl:
        env.ADDROID_CODEX_APP_SERVER_URL?.trim() ||
        env.CODEX_APP_SERVER_URL?.trim() ||
        null,
      codexBin: env.CODEX_BIN?.trim() || "codex",
      timeoutMs: 30_000,
    });
    try {
      return Boolean(await provider.getConnection());
    } finally {
      provider.close();
    }
  } catch {
    return false;
  }
}

function resolveDefaultEnvFile(): string {
  try {
    return path.join(resolveRepoRoot(), ".env");
  } catch {
    return path.resolve(process.cwd(), ".env");
  }
}

function resolveInitDatabaseUrl(
  opts: InitOptions,
  env: NodeJS.ProcessEnv,
  overrides: InitCommandOverrides
): string {
  if (opts.databaseUrl) return opts.databaseUrl;
  if (env.DATABASE_URL && !isPlaceholderEnvValue("DATABASE_URL", env.DATABASE_URL)) {
    return env.DATABASE_URL;
  }
  return buildDefaultDatabaseUrl(generateDatabasePassword(overrides));
}

function buildDefaultDatabaseUrl(password: string): string {
  const encodedUser = encodeURIComponent(DEFAULT_DATABASE_USER);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${DEFAULT_DATABASE_HOST}:${DEFAULT_DATABASE_PORT}/${DEFAULT_DATABASE_NAME}`;
}

function maybeCreateLocalDatabase(
  databaseUrl: string,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { ok: boolean; detail: string } {
  if (!isDefaultLocalDatabase(databaseUrl)) {
    return { ok: true, detail: "custom DATABASE_URL のため DB 自動作成はスキップしました。" };
  }
  const parsed = new URL(databaseUrl);
  const password = decodeURIComponent(parsed.password);
  if (!password) {
    return {
      ok: false,
      detail: "local DATABASE_URL に password がありません。`addroid init` で生成した URL を使うか、password 付き URL を指定してください。",
    };
  }
  const sql = [
    "DO $$",
    "BEGIN",
    "  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'addroid') THEN",
    `    CREATE ROLE addroid LOGIN PASSWORD ${sqlLiteral(password)};`,
    "  ELSE",
    `    ALTER ROLE addroid WITH LOGIN PASSWORD ${sqlLiteral(password)};`,
    "  END IF;",
    "END",
    "$$;",
    "SELECT 'CREATE DATABASE addroid OWNER addroid'",
    "WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'addroid')\\gexec",
    "GRANT ALL PRIVILEGES ON DATABASE addroid TO addroid;",
    "\\connect addroid",
    "ALTER SCHEMA public OWNER TO addroid;",
    "GRANT ALL ON SCHEMA public TO addroid;",
    "",
  ].join("\n");
  const r = runner("psql", ["-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    env,
    input: sql,
    timeoutMs: 30_000,
  });
  if (r.status === 0) {
    return { ok: true, detail: "addroid role/database ready" };
  }
  return {
    ok: false,
    detail: summarizeCommandFailure(r),
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPrismaSetup(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { ok: boolean; detail: string } {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (err) {
    return {
      ok: false,
      detail: `repo root を特定できません: ${(err as Error).message}`,
    };
  }
  const generate = runner("npm", ["run", "db:generate"], { cwd: repoRoot, env, timeoutMs: 120_000 });
  if (generate.status !== 0) return { ok: false, detail: summarizeCommandFailure(generate) };
  const push = runner("npm", ["run", "db:push", "--", "--accept-data-loss"], {
    cwd: repoRoot,
    env,
    timeoutMs: 180_000,
  });
  if (push.status !== 0) return { ok: false, detail: summarizeCommandFailure(push) };
  return { ok: true, detail: "Prisma client generated and schema pushed" };
}

async function installMissingDependencies(
  checks: CheckResult[],
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  opts: { assumeYes?: boolean; confirm?: ConfirmFn } = {}
): Promise<Array<{ label: string; outcome: { ok: boolean; detail: string } }>> {
  const out: Array<{ label: string; outcome: { ok: boolean; detail: string } }> = [];
  for (const check of checks) {
    if (check.name === "github-cli") {
      const command =
        process.platform === "darwin"
          ? "brew install gh"
          : process.platform === "linux"
            ? "sudo apt-get update && sudo apt-get install -y gh (or GitHub CLI official package repository)"
            : "install GitHub CLI with your OS package manager";
      const approval = await confirmInstallCommand(opts, "GitHub CLI", command, true);
      if (!approval.ok) {
        out.push({ label: "GitHub CLI", outcome: approval.outcome });
        return out;
      }
      const outcome = installGithubCli(runner, env);
      out.push({ label: "GitHub CLI", outcome });
      if (!outcome.ok) return out;
    }
    if (check.name === "codex-cli") {
      const command = "npm install -g @openai/codex";
      const approval = await confirmInstallCommand(opts, "Codex CLI", command, true);
      if (!approval.ok) {
        out.push({ label: "Codex CLI", outcome: approval.outcome });
        return out;
      }
      const r = runVisibleCommand(
        "Codex CLI",
        command,
        runner,
        "npm",
        ["install", "-g", "@openai/codex"],
        { env, timeoutMs: 300_000 }
      );
      out.push({ label: "Codex CLI", outcome: commandOutcome(r, "Codex CLI installed") });
      if (!out[out.length - 1]!.outcome.ok) return out;
    }
    if (check.name === "postgres-16") {
      const command =
        process.platform === "darwin"
          ? "brew install postgresql@16 && stop older Homebrew PostgreSQL services && brew services start postgresql@16"
          : process.platform === "linux"
            ? "sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-client-16 (or dnf equivalent)"
            : "install PostgreSQL 16+ with your OS package manager";
      const approval = await confirmInstallCommand(opts, "PostgreSQL 16+", command, true);
      if (!approval.ok) {
        out.push({ label: "PostgreSQL 16+", outcome: approval.outcome });
        return out;
      }
      const outcome = installPostgres(runner, env);
      out.push({ label: "PostgreSQL 16+", outcome });
      if (!outcome.ok) return out;
    }
  }
  return out;
}

async function confirmInstallCommand(
  opts: { assumeYes?: boolean; confirm?: ConfirmFn },
  label: string,
  command: string,
  defaultYes: boolean
): Promise<{ ok: true } | { ok: false; outcome: { ok: false; detail: string } }> {
  if (opts.assumeYes || !opts.confirm) return { ok: true };
  const approved = await opts.confirm(`${label} を次のコマンドでインストールしますか? ${command}`, defaultYes);
  return approved ? { ok: true } : { ok: false, outcome: { ok: false, detail: "skipped by user" } };
}

async function setupDependencies(opts: {
  opts: InitOptions;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}): Promise<{ ok: boolean; lines: string[] }> {
  const checks = [
    checkPlatform(),
    checkGithubCli(),
    checkPostgresVersion(),
  ];
  const lines = ["", "Dependency setup:"];
  for (const c of checks) lines.push(formatCheck(c));
  const failing = checks.filter(needsSetupAction);
  if (failing.length === 0) {
    return { ok: true, lines };
  }
  process.stdout.write(lines.join("\n") + "\n");
  lines.length = 0;
  const installResults = await installMissingDependencies(failing, opts.runner, opts.env);
  for (const r of installResults) {
    lines.push(...formatCommandOutcome(r.label, r.outcome));
    if (!r.outcome.ok) {
      return { ok: false, lines };
    }
  }
  return { ok: true, lines };
}

function installGithubCli(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { ok: boolean; detail: string } {
  if (process.platform === "darwin") {
    const brew = runner("brew", ["--version"], { env, timeoutMs: 10_000 });
    if (brew.status !== 0) {
      return { ok: false, detail: "Homebrew が見つかりません。brew install gh を手動実行してください。" };
    }
    const install = runVisibleCommand(
      "GitHub CLI",
      "brew install gh",
      runner,
      "brew",
      ["install", "gh"],
      { env, timeoutMs: 300_000 }
    );
    return commandOutcome(install, "GitHub CLI installed");
  }
  if (process.platform === "linux") {
    const apt = runner("sh", ["-c", "command -v apt-get >/dev/null 2>&1"], { env, timeoutMs: 10_000 });
    if (apt.status === 0) {
      const install = runVisibleCommand(
        "GitHub CLI",
        "sudo apt-get update && sudo apt-get install -y gh",
        runner,
        "sh",
        ["-c", "sudo apt-get update && sudo apt-get install -y gh"],
        { env, timeoutMs: 300_000 }
      );
      return commandOutcome(install, "GitHub CLI installed");
    }
    const dnf = runner("sh", ["-c", "command -v dnf >/dev/null 2>&1"], { env, timeoutMs: 10_000 });
    if (dnf.status === 0) {
      const install = runVisibleCommand(
        "GitHub CLI",
        "sudo dnf install -y gh",
        runner,
        "sh",
        ["-c", "sudo dnf install -y gh"],
        { env, timeoutMs: 300_000 }
      );
      return commandOutcome(install, "GitHub CLI installed");
    }
  }
  return { ok: false, detail: "このOSでは GitHub CLI の自動インストール手順を判定できませんでした。" };
}

function installPostgres(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { ok: boolean; detail: string } {
  if (process.platform === "darwin") {
    const brew = runner("brew", ["--version"], { env, timeoutMs: 10_000 });
    if (brew.status !== 0) {
      return { ok: false, detail: "Homebrew が見つかりません。brew install postgresql@16 を手動実行してください。" };
    }
    const install = runVisibleCommand(
      "PostgreSQL 16+",
      "brew install postgresql@16",
      runner,
      "brew",
      ["install", "postgresql@16"],
      { env, timeoutMs: 300_000 }
    );
    if (install.status !== 0) return { ok: false, detail: summarizeCommandFailure(install) };
    const bin = prependHomebrewPostgres16BinToPath(runner, env);
    for (const service of runningOlderHomebrewPostgresServices(runner, env)) {
      const stop = runVisibleCommand(
        "PostgreSQL 16+",
        `brew services stop ${service}`,
        runner,
        "brew",
        ["services", "stop", service],
        { env, timeoutMs: 60_000 }
      );
      if (stop.status !== 0) {
        return { ok: false, detail: `古い PostgreSQL service (${service}) を停止できません: ${summarizeCommandFailure(stop)}` };
      }
    }
    const start = runVisibleCommand(
      "PostgreSQL 16+",
      "brew services start postgresql@16",
      runner,
      "brew",
      ["services", "start", "postgresql@16"],
      { env, timeoutMs: 60_000 }
    );
    if (start.status !== 0) return { ok: false, detail: summarizeCommandFailure(start) };
    const server = detectLocalPostgresServerMajor(runner, env);
    if (server.major !== null && server.major < 16) {
      return {
        ok: false,
        detail:
          `localhost:5432 ではまだ PostgreSQL ${server.major} が応答しています。` +
          " Homebrew 以外で起動した古い PostgreSQL を停止し、postgresql@16 を起動してから再実行してください。",
      };
    }
    const pathNote = bin ? `; PATH updated for this init (${bin})` : "";
    return {
      ok: true,
      detail: `PostgreSQL service started${server.major ? ` (server ${server.major})` : ""}${pathNote}`,
    };
  }
  if (process.platform === "linux") {
    const apt = runner("sh", ["-c", "command -v apt-get >/dev/null 2>&1"], { env, timeoutMs: 10_000 });
    if (apt.status === 0) {
      const install = runVisibleCommand(
        "PostgreSQL 16+",
        "sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-client-16",
        runner,
        "sh",
        ["-c", "sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-client-16"],
        { env, timeoutMs: 300_000 }
      );
      return commandOutcome(install, "PostgreSQL packages installed");
    }
    const dnf = runner("sh", ["-c", "command -v dnf >/dev/null 2>&1"], { env, timeoutMs: 10_000 });
    if (dnf.status === 0) {
      const install = runVisibleCommand(
        "PostgreSQL 16+",
        "sudo dnf install -y postgresql-server postgresql",
        runner,
        "sh",
        ["-c", "sudo dnf install -y postgresql-server postgresql"],
        {
          env,
          timeoutMs: 300_000,
        }
      );
      return commandOutcome(install, "PostgreSQL packages installed");
    }
  }
  return { ok: false, detail: "このOSでは PostgreSQL の自動インストール手順を判定できませんでした。" };
}

function prependHomebrewPostgres16BinToPath(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): string | null {
  const prefix = runner("brew", ["--prefix", "postgresql@16"], { env, timeoutMs: 10_000 });
  const root = prefix.stdout.trim();
  if (prefix.status !== 0 || !root) return null;
  const bin = path.join(root, "bin");
  const current = env.PATH ?? "";
  const entries = current.split(path.delimiter).filter(Boolean);
  if (!entries.some((entry) => path.resolve(entry) === path.resolve(bin))) {
    env.PATH = [bin, ...entries].join(path.delimiter);
  }
  return bin;
}

function runningOlderHomebrewPostgresServices(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): string[] {
  const list = runner("brew", ["services", "list"], { env, timeoutMs: 20_000 });
  if (list.status !== 0) return [];
  return list.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, status]) =>
      Boolean(
        name &&
          status === "started" &&
          /^postgresql(?:@\d+)?$/.test(name) &&
          name !== "postgresql@16"
      )
    )
    .map(([name]) => name!);
}

function detectLocalPostgresServerMajor(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): { major: number | null; detail: string } {
  const r = runner("psql", [
    "-d",
    "postgres",
    "-Atc",
    "select current_setting('server_version_num')",
  ], {
    env,
    timeoutMs: 10_000,
  });
  if (r.status !== 0) return { major: null, detail: summarizeCommandFailure(r) };
  const num = Number(r.stdout.trim());
  const major = Math.floor(num / 10000);
  if (!Number.isFinite(major) || major <= 0) return { major: null, detail: r.stdout.trim() };
  return { major, detail: r.stdout.trim() };
}

function runVisibleCommand(
  label: string,
  commandForDisplay: string,
  runner: CommandRunner,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }
): CommandResult {
  const startedAt = Date.now();
  process.stdout.write(`  ${label}: running\n`);
  process.stdout.write(`    $ ${commandForDisplay}\n`);
  process.stdout.write("    インストール中です。数分かかる場合があります。コマンド出力をそのまま表示します。\n");
  const result = runner(cmd, args, { ...opts, streamOutput: true });
  const elapsed = formatElapsed(Date.now() - startedAt);
  process.stdout.write(`  ${label}: finished (${elapsed})\n`);
  return result;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function commandOutcome(r: CommandResult, success: string): { ok: boolean; detail: string } {
  if (r.status === 0) return { ok: true, detail: success };
  return { ok: false, detail: summarizeCommandFailure(r) };
}

function defaultRunCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    streamOutput?: boolean;
  } = {}
): CommandResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    encoding: "utf8",
    ...(opts.streamOutput
      ? { stdio: [opts.input === undefined ? "ignore" : "pipe", "inherit", "inherit"] as const }
      : {}),
    timeout: opts.timeoutMs ?? 120_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

function summarizeCommandFailure(r: CommandResult): string {
  if (r.error) return r.error.message;
  const detail = (r.stderr || r.stdout || "").trim();
  return `exit ${r.status ?? "unknown"}${detail ? `: ${detail.split(/\r?\n/).slice(-4).join(" ")}` : ""}`;
}

async function withRuntimeEnv<T>(
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>
): Promise<T> {
  if (env === process.env) return await fn();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function defaultPrompt(question: string, defaultValue = ""): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue} / Enterで既定]` : "";
  return rl.question(`? ${question}${suffix}: `).then((answer) => {
    rl.close();
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : defaultValue;
  });
}

function buildPromptSelect(prompt: PromptFn): SelectFn {
  return async (question, options, defaultValue) => {
    const choices = options.map((o) => o.value).join(" / ");
    return await prompt(`${question} (${choices})`, defaultValue);
  };
}

function defaultSelectOption(
  question: string,
  options: readonly SelectOption[],
  defaultValue: string
): Promise<string> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    return buildPromptSelect(defaultPrompt)(question, options, defaultValue);
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const defaultIndex = Math.max(
      0,
      options.findIndex((o) => o.value === defaultValue)
    );
    let highlighted = defaultIndex;
    let selected = defaultIndex;
    let renderedLines = 0;

    const render = () => {
      if (renderedLines > 0) {
        readlineControl.moveCursor(process.stdout, 0, -renderedLines);
        readlineControl.cursorTo(process.stdout, 0);
        readlineControl.clearScreenDown(process.stdout);
      }
      const lines = [
        `? ${question} (↑/↓で移動、Spaceで選択、Enterで確定)`,
        ...options.map((option, i) => {
          const cursor = i === highlighted ? ">" : " ";
          const checked = i === selected ? "[x]" : "[ ]";
          return `${cursor} ${checked} ${option.label} - ${option.description}`;
        }),
      ];
      process.stdout.write(lines.join("\n") + "\n");
      renderedLines = lines.length;
    };

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (s === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("interrupted"));
        return;
      }
      if (s === "\r" || s === "\n") {
        cleanup();
        resolve(options[selected]?.value ?? defaultValue);
        return;
      }
      if (s === " ") {
        selected = highlighted;
        render();
        return;
      }
      if (s === "\u001b[A" || s === "k") {
        highlighted = (highlighted - 1 + options.length) % options.length;
        render();
        return;
      }
      if (s === "\u001b[B" || s === "j") {
        highlighted = (highlighted + 1) % options.length;
        render();
      }
    };

    render();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function defaultConfirm(question: string, defaultYes = false): Promise<boolean> {
  const answer = await defaultPrompt(`${question} ${defaultYes ? "(Y/n)" : "(y/N)"}`, "");
  if (!answer) return defaultYes;
  return /^(y|yes|はい|ok)$/i.test(answer.trim());
}

function generateEncryptionKey(overrides: InitCommandOverrides): string {
  const rb = overrides.randomBytes ?? randomBytes;
  return rb(32).toString("base64");
}

function generateDatabasePassword(overrides: InitCommandOverrides): string {
  const rb = overrides.randomBytes ?? randomBytes;
  return rb(18).toString("base64url");
}

function isDefaultLocalDatabase(databaseUrl: string): boolean {
  try {
    const u = new URL(databaseUrl);
    return (
      (u.protocol === "postgresql:" || u.protocol === "postgres:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.port === "" || u.port === "5432") &&
      u.pathname.replace(/^\//, "") === "addroid" &&
      u.username === "addroid"
    );
  } catch {
    return false;
  }
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default";
}

function stripEnvQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@%?&=+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function isPlaceholderEnvValue(key: string, value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (key === "DATABASE_URL") {
    return /USER:PASSWORD|replace|placeholder/i.test(v);
  }
  if (key === "ENCRYPTION_KEY") {
    return /replace-with|placeholder|random-value/i.test(v) || v.length < 32;
  }
  return /replace|placeholder/i.test(v);
}

function printScaffoldResult(result: ScaffoldResult, cliLinkLines: string[] = []): void {
  const lines = ["[addroid init]", "", ...formatScaffoldResult(result)];
  if (cliLinkLines.length > 0) {
    lines.push("", ...cliLinkLines.filter((line) => line.length > 0));
  }
  lines.push("", "Next steps:");
  if (!process.env.DATABASE_URL) {
    lines.push("  1. addroid init --interactive    # .env / DB まで対話セットアップ");
    lines.push("  2. addroid status");
    lines.push("  3. Meta App に Privacy Policy URL を設定し、Live / 公開にする");
    lines.push("  4. Meta Access Token を用意");
    lines.push("  5. addroid connect meta          # token 入力 + Ad Account 選択");
    lines.push("  6. addroid connect github        # GitHub 認証 + ops repo 作成");
    lines.push("  7. addroid connect ai            # Codex app-server / OpenAI / Claude を選択");
    lines.push("  8. addroid start");
  } else {
    lines.push("  1. addroid status");
    lines.push("  2. Meta App に Privacy Policy URL を設定し、Live / 公開にする");
    lines.push("  3. Meta Access Token を用意");
    lines.push("  4. addroid connect meta          # token 入力 + Ad Account 選択");
    lines.push("  5. addroid connect github        # GitHub 認証 + ops repo 作成");
    lines.push("  6. addroid connect ai            # Codex app-server / OpenAI / Claude を選択");
    lines.push("  7. addroid start");
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

async function printAlreadyInitializedResult(
  result: ScaffoldResult,
  auth: InitAuthState,
  cliLinkLines: string[] = [],
  metaCliSetupLines: string[] = [],
  serviceSetupLines: string[] = []
): Promise<void> {
  const lines = [
    "[addroid init]",
    "",
    "AdDroid is already initialized. Existing config / secrets / credentials were left as-is.",
    "",
    ...formatScaffoldResult(result),
    "",
    "Connected credentials:",
    `  Meta Token    : ${auth.metaConnected ? "configured" : "not detected"}`,
    `  Meta Account  : ${auth.metaAccountSelected ? "selected" : "not detected"}`,
    `  GitHub       : ${auth.githubConnected ? "configured" : "not detected"}`,
    `  Ops Repo     : ${auth.opsRepoLinked ? "linked" : "not linked"}`,
    `  LLM Provider  : ${auth.llmProviders.length > 0 ? auth.llmProviders.join(", ") : "not detected"}`,
  ];
  if (!auth.checked && auth.detail) {
    lines.push(`  auth check    : skipped (${auth.detail})`);
  }
  lines.push("");
  if (cliLinkLines.length > 0) {
    lines.push(...cliLinkLines.filter((line) => line.length > 0));
    lines.push("");
  }
  if (metaCliSetupLines.length > 0) {
    lines.push(...metaCliSetupLines.filter((line) => line.length > 0));
    lines.push("");
  }
  if (serviceSetupLines.length > 0) {
    const [, ...serviceLines] =
      serviceSetupLines[0] === "常駐サービス:" ? serviceSetupLines : ["", ...serviceSetupLines];
    lines.push("Service:");
    lines.push(...serviceLines);
  } else {
    lines.push("Service:");
    const service = await import("../lib/service.js")
      .then((mod) => mod.getAddroidServiceStatus())
      .catch((err) => ({
        platform: "unsupported" as const,
        installed: false,
        running: false,
        detail: (err as Error).message,
      }));
    lines.push(...formatServiceStatus(service));
  }
  lines.push("");
  lines.push(...formatCommonCommandGuide());
  lines.push("");
  lines.push("接続を直すとき:");
  lines.push("  addroid connect meta       # Meta token を再認証");
  lines.push("  addroid connect github     # GitHub token / ops repo を再設定");
  lines.push("  addroid connect ai         # LLM provider を選び直して再認証");
  lines.push("");
  lines.push("初期設定をやり直すとき:");
  lines.push("  addroid init --force       # 初期セットアップ全体を明示的に再確認");
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function formatScaffoldResult(result: ScaffoldResult): string[] {
  return [
    `  home          : ${result.paths.home}`,
    `  storage       : ${result.paths.storageDir}`,
    `  logs          : ${result.paths.logsDir}`,
    `  run           : ${result.paths.runDir}`,
    `  config        : ${result.configPath} ${result.configWrote ? "(updated)" : "(unchanged)"}`,
    `  secrets file  : ${result.paths.secretsFile} ${
      result.secretsCreated ? "(created stub)" : "(left as-is)"
    }`,
  ];
}

function formatEnvResult(result: EnvEnsureResult): string[] {
  const changed = result.updated.length > 0 ? result.updated.join(", ") : "none";
  const kept = result.kept.length > 0 ? `; kept existing: ${result.kept.join(", ")}` : "";
  const lines = [
    `  env           : ${result.path} ${result.wrote ? "(updated)" : "(unchanged)"}`,
    `                  updated: ${changed}${kept}`,
  ];
  // 既存の ENCRYPTION_KEY / DATABASE_URL は上書きしない。ディレクトリごと受け渡された
  // 環境ではこれが「前の所有者の鍵」であり、保存済みトークンを相互に復号できてしまう。
  // git clone 以外の経路で配布された場合に気づけるよう、必ず警告を出す。
  const inherited = ["ENCRYPTION_KEY", "DATABASE_URL"].filter((key) =>
    result.kept.includes(key)
  );
  if (inherited.length > 0) {
    lines.push(
      `                  warning: 既存の ${inherited.join(" / ")} を再利用しました。`,
      "                           このディレクトリを他者から受け取った場合は使い続けないでください。",
      "                           .env から該当行を削除して `addroid init` を再実行し、",
      "                           各 provider を接続し直してください (`addroid connect <provider>`)。"
    );
  }
  return lines;
}

function formatCommandOutcome(label: string, outcome: { ok: boolean; detail: string }): string[] {
  return [`  ${label.padEnd(14)}: ${outcome.ok ? "ok" : "error"} - ${outcome.detail}`];
}

function formatCheck(c: CheckResult): string {
  const state = c.state.padEnd(7);
  return `  [${state}] ${c.name.padEnd(17)} ${c.message}`;
}

function formatIntegrationCheck(auth: InitAuthState, opts: InitOptions): string[] {
  if (opts.mockIntegrations) {
    return [
      formatIntegrationLine("ok", "Meta Token", "mock mode enabled"),
      formatIntegrationLine("ok", "Meta Account", "mock mode enabled"),
      formatIntegrationLine("ok", "LLM Provider", "mock mode enabled"),
      formatIntegrationLine("ok", "GitHub / Ops Repo", "mock mode enabled"),
    ];
  }
  if (!auth.checked) {
    const detail = auth.detail ? ` (${auth.detail})` : "";
    return [
      formatIntegrationLine(
        "pending",
        "Meta Token",
        `.env / DB 作成後に init 内で token 入力 + Ad Account 選択を行います${detail}`
      ),
      formatIntegrationLine(
        "pending",
        "LLM Provider",
        ".env / DB 作成後に Codex app-server / OpenAI / Anthropic を選択して認証します"
      ),
      formatIntegrationLine(
        "pending",
        "GitHub / Ops Repo",
        ".env / DB 作成後に GitHub 認証 + ops repo 自動作成を行います"
      ),
    ];
  }
  const githubReady = auth.githubConnected !== false && auth.opsRepoLinked !== false;
  return [
    formatIntegrationLine(
      auth.metaConnected ? "ok" : "missing",
      "Meta Token",
      auth.metaConnected ? "configured" : "init 内で token 入力を行います"
    ),
    formatIntegrationLine(
      auth.metaAccountSelected ? "ok" : "missing",
      "Meta Account",
      auth.metaAccountSelected ? "selected" : "init 内で Ad Account 選択を行います"
    ),
    formatIntegrationLine(
      auth.llmProviders.length > 0 ? "ok" : "missing",
      "LLM Provider",
      auth.llmProviders.length > 0
        ? auth.llmProviders.join(", ")
        : "init 内で Codex app-server / OpenAI / Anthropic を選択して認証します"
    ),
    formatIntegrationLine(
      githubReady ? "ok" : "missing",
      "GitHub / Ops Repo",
      githubReady
        ? "configured + linked"
        : "init 内で GitHub 認証 + ops repo 自動作成を行います"
    ),
  ];
}

function formatIntegrationLine(
  state: "ok" | "missing" | "pending",
  name: string,
  message: string
): string {
  return `  [${state.padEnd(7)}] ${name.padEnd(17)} ${message}`;
}

function needsSetupAction(c: CheckResult): boolean {
  if (c.state === "error") return true;
  return c.name === "postgres-16" && c.state === "warn";
}

function formatConfigParseError(err: ConfigParseError): string {
  return [
    `[addroid init] 既存の ${err.file} がスキーマと一致しません:`,
    ...err.issues.map((m) => `  - ${m}`),
    "  既存ファイルを破壊しないため init を中断しました。手動で修正後に再実行してください。",
    "",
  ].join("\n");
}

function parseInitArgs(args: string[]): InitOptions {
  const opts: InitOptions = {
    yes: false,
    installDeps: false,
    skipDeps: false,
    skipDbCreate: false,
    skipDbPush: false,
    dbPush: false,
    mockIntegrations: false,
    skipLinkCli: false,
    force: false,
    reauthMeta: false,
    reauthGithub: false,
    reauthLlm: false,
    noChat: false,
    noService: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const next = () => {
      const v = args[++i];
      if (!v) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--interactive") opts.interactive = true;
    else if (a === "--non-interactive" || a === "--no-interactive") opts.interactive = false;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--install-deps") opts.installDeps = true;
    else if (a === "--skip-deps") opts.skipDeps = true;
    else if (a === "--skip-db-create") opts.skipDbCreate = true;
    else if (a === "--skip-db-push") opts.skipDbPush = true;
    else if (a === "--db-push") opts.dbPush = true;
    else if (a === "--mock-integrations") opts.mockIntegrations = true;
    else if (a === "--skip-link-cli") opts.skipLinkCli = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--reauth-meta") opts.reauthMeta = true;
    else if (a === "--reauth-github") opts.reauthGithub = true;
    else if (a === "--reauth-llm") opts.reauthLlm = true;
    else if (a === "--no-chat") opts.noChat = true;
    else if (a === "--no-service") opts.noService = true;
    else if (a === "--project-name") opts.projectName = next();
    else if (a.startsWith("--project-name=")) opts.projectName = a.slice("--project-name=".length);
    else if (a === "--language" || a === "--lang") opts.language = parseLanguageOption(next());
    else if (a.startsWith("--language=")) opts.language = parseLanguageOption(a.slice("--language=".length));
    else if (a.startsWith("--lang=")) opts.language = parseLanguageOption(a.slice("--lang=".length));
    else if (a === "--database-url") opts.databaseUrl = next();
    else if (a.startsWith("--database-url=")) opts.databaseUrl = a.slice("--database-url=".length);
    else if (a === "--env-file") opts.envFile = next();
    else if (a.startsWith("--env-file=")) opts.envFile = a.slice("--env-file=".length);
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

function parseLanguageOption(value: string): AddroidLanguagePreference {
  const parsed = normalizeAddroidLanguagePreference(value);
  if (!parsed) throw new Error("--language must be auto, ja, or en");
  return parsed;
}

function printInitHelp(): void {
  if (resolveAddroidLanguage({ env: process.env }) === "en") {
    process.stdout.write(
      [
        "addroid init — first-run setup wizard",
        "",
        "Usage:",
        "  addroid init",
        "  addroid init --non-interactive --yes [--project-name NAME] [--database-url URL]",
        "",
        "Options:",
        "  --interactive          Force the interactive wizard",
        "  --non-interactive      Run without prompts; alone, this only creates the ~/.addroid scaffold",
        "  --yes, -y              Initialize .env and DB defaults without confirmation",
        "  --project-name NAME    Set the workspace name",
        "  --language auto|ja|en  Set UI / CLI / Agent language (default: auto)",
        "  --database-url URL     DATABASE_URL to save in .env",
        "  --env-file PATH        Env file to write (default: repo-root .env)",
        "  --install-deps         Explicitly install missing GitHub CLI / PostgreSQL dependencies",
        "  --skip-deps            Skip dependency diagnosis",
        "  --skip-db-create       Skip local DB / role creation",
        "  --db-push              Run npm run db:generate && npm run db:push",
        "  --skip-db-push         Skip Prisma schema application",
        "  --mock-integrations    Add mock flags to .env for first-run verification",
        "  --skip-link-cli        Skip checkout link for the `addroid` command",
        "  --force                Re-run setup checks even if initialization is detected",
        "  --reauth-meta          Compatibility: rerun only Meta connection. Usually use `addroid connect meta`",
        "  --reauth-github        Compatibility: rerun only GitHub connection. Usually use `addroid connect github`",
        "  --reauth-llm           Compatibility: rerun only LLM connection. Usually use `addroid connect ai`",
        "  --no-chat              Do not auto-start `addroid chat` after setup",
        "  --no-service           Skip resident-service auto-install after setup",
        "",
        "Interactive setup:",
        "  A Meta Access Token is required to use a real Meta ad account.",
        "  The default setup does not use an OAuth callback; after token input, selectable Ad Accounts are shown.",
        "  Production submission requires a Privacy Policy URL and Live/public mode on the issuing Meta App.",
        "  `addroid connect meta` encrypts and saves the token, then lets you select an Ad Account.",
        "",
      ].join("\n")
    );
    return;
  }
  process.stdout.write(
    [
      "addroid init — first-run setup wizard",
      "",
      "Usage:",
      "  addroid init",
      "  addroid init --non-interactive --yes [--project-name NAME] [--database-url URL]",
      "",
      "Options:",
      "  --interactive          対話型ウィザードを強制 (通常の端末では省略可)",
      "  --non-interactive      対話せず実行。単独指定時は ~/.addroid scaffold のみ作成",
      "  --yes, -y              既定値で .env・DB を初期化し、確認を省略",
      "  --project-name NAME    workspace 名を設定",
      "  --language auto|ja|en  UI / CLI / Agent の表示言語を設定 (既定: auto)",
      "  --database-url URL     .env に保存する DATABASE_URL",
      "  --env-file PATH        書き込み先 env file (既定: repo root の .env)",
      "  --install-deps         GitHub CLI / PostgreSQL の不足分を明示的にインストール",
      "  --skip-deps            依存診断をスキップ",
      "  --skip-db-create       ローカル DB / role 作成をスキップ",
      "  --db-push              npm run db:generate && npm run db:push を実行",
      "  --skip-db-push         Prisma schema 反映をスキップ",
      "  --mock-integrations    初回検証用に mock フラグを .env に追加",
      "  --skip-link-cli        `addroid` コマンドの checkout link をスキップ",
      "  --force                初期化済み検出を無視してセットアップ確認を再実行",
      "  --reauth-meta          互換用: Meta 接続だけを再実行。通常は `addroid connect meta`",
      "  --reauth-github        互換用: GitHub 接続だけを再実行。通常は `addroid connect github`",
      "  --reauth-llm           互換用: LLM 接続だけを再実行。通常は `addroid connect ai`",
      "  --no-chat              セットアップ完了後に `addroid chat` を自動起動しない",
      "  --no-service           セットアップ完了後の常駐サービス自動インストールをスキップ",
      "",
      "Interactive setup:",
      "  実際の Meta 広告アカウントを利用するには Meta Access Token が必須です。",
      "  標準設定では OAuth callback を使わず、token 入力後に取得可能な Ad Account を表示します。",
      "  本番入稿には、token 発行元 Meta App の Privacy Policy URL 設定と Live / 公開モードが必要です。",
      "  `addroid connect meta` で token を暗号化保存し、Ad Account を選択します。",
      "  OAuth callback を使う上級者向け経路は詳細コマンド `addroid auth meta --oauth` です。",
      "  LLM Provider は openai-api-key / anthropic-api-key / codex-app-server から選択できます。",
      "  OpenAI / Anthropic API key は `addroid connect ai` 経由で ENCRYPTION_KEY により暗号化保存されます。Codex token は AdDroid には保存しません。",
      "",
    ].join("\n")
  );
}
