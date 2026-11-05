"use strict";

// 内容包投稿机器人：校验 Issue 里上传的 .zip，维护者 /approve 后在 diceframe 组织下
// 建 module-<插件 ID> 仓库、推送内容、发布 Release，并写入索引。
// 解压与内容校验交给 DiceFrame 自己的 scripts/validate_content_module.py（与安装同一套规则）。
//
// 这里只有编排逻辑；GitHub API、Git、下载、校验器都可以注入，便于在 CI 里跑
// 不接触真实组织仓库的隔离测试（tests/content-submission.test.cjs）。

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  effectivePermissions,
  generateDetails,
  githubApi,
  readJson,
  validateManifest,
  writeJson,
} = require("./registry.cjs");
const hosting = require("./content-hosting.cjs");

const ROOT = path.resolve(__dirname, "..");
const BOT_NAME = "diceframe-registry[bot]";
const BOT_EMAIL = "diceframe-registry[bot]@users.noreply.github.com";
const BOT_LOGIN = "github-actions[bot]";
const STATUS_LABELS = ["pending-validation", "validated", "validation-failed", "approved", "rejected"];
const LABELS = {
  "content-pack-submission": ["8250df", "Content pack submission"],
  "pending-validation": ["d4c5f9", "Waiting for automated validation"],
  "validated": ["0e8a16", "Automated validation passed"],
  "validation-failed": ["d73a4a", "Automated validation failed"],
  "approved": ["1d76db", "Approved and added to the registry"],
  "rejected": ["b60205", "Rejected by a maintainer"],
};

const APPROVE_COMMENT_RE = /^\/approve\s*$/i;
const RECHECK_COMMENT_RE = /^\/recheck\s*$/i;
const REJECT_COMMENT_RE = /^\/reject(?:\s+[\s\S]+)?$/i;

// ---------------------------------------------------------------------------
// 日志与评论里的凭据/伪造标记清理（SEC-1 / APPROVE-1）
// ---------------------------------------------------------------------------

function redactSecret(text, secrets = []) {
  let value = String(text === undefined || text === null ? "" : text);
  for (const secret of secrets) {
    if (secret) value = value.split(String(secret)).join("[redacted]");
  }
  return value
    .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/(AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+/=]+/gi, "$1[redacted]")
    .replace(/x-access-token:[^\s@]+/gi, "x-access-token:[redacted]");
}

/** 只允许机器人自己生成 HTML 注释标记；任何来自投稿/校验器的文本都要先去掉注释。 */
function safeText(text, secrets = [], limit = 4000) {
  return redactSecret(text, secrets)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/diceframe-content-(?:validation|publish)/g, "diceframe-content-blocked")
    .slice(0, limit);
}

function tableCell(value, secrets = []) {
  return safeText(value, secrets, 200).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

// ---------------------------------------------------------------------------
// 下载与校验（真实实现；测试里注入替身）
// ---------------------------------------------------------------------------

async function downloadPackage(url) {
  const tooLarge = `插件包不能超过 ${hosting.MAX_PACKAGE_BYTES / 1024 / 1024} MB`;
  // 不带 Token：公开仓库的附件可以匿名下载，也避免把凭据跟着重定向发出去。
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "diceframe-plugin-registry" } });
  if (!response.ok) throw new Error(`下载插件包失败：HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") || 0) > hosting.MAX_PACKAGE_BYTES) throw new Error(tooLarge);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > hosting.MAX_PACKAGE_BYTES) throw new Error(tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractPackage(payload) {
  const diceframeRoot = process.env.DICEFRAME_ROOT || "";
  const python = process.env.PYTHON || "python";
  const workRoot = process.env.RUNNER_TEMP || os.tmpdir();
  if (!diceframeRoot) throw new Error("DICEFRAME_ROOT 未设置，找不到 DiceFrame 校验器");
  const work = fs.mkdtempSync(path.join(workRoot, "content-pack-"));
  const archive = path.join(work, "package.zip");
  const moduleDir = path.join(work, "module");
  fs.writeFileSync(archive, payload);
  const script = path.join(diceframeRoot, "scripts", "validate_content_module.py");
  let stdout;
  try {
    stdout = execFileSync(python, ["-I", script, archive, "--json", "--extract-to", moduleDir], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // 校验不通过时脚本以退出码 1 结束，但仍会输出 JSON 报告。
    stdout = error.stdout;
    if (!stdout) throw new Error(`校验器运行失败：${String(error.stderr || error.message).slice(-800)}`);
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error("校验器输出不是 JSON");
  }
  return { report, moduleDir };
}

function readConfigSchema(moduleDir, manifest) {
  const relative = String(manifest.config_schema || "config.schema.json").trim();
  const resolved = path.resolve(moduleDir, relative);
  if (!resolved.startsWith(path.resolve(moduleDir) + path.sep) || !fs.existsSync(resolved)) {
    throw new Error(`plugin.json 指向的配置文件不存在：${relative}`);
  }
  const schema = readJson(resolved);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("配置 Schema 必须是 JSON 对象");
  return schema;
}

// ---------------------------------------------------------------------------
// Git（SEC-1：不继承任何投稿可控的 Git 配置、钩子、过滤器）
// ---------------------------------------------------------------------------

function createGitRunner({ workRoot, token, allowedProtocols = "https" }) {
  const scratch = fs.mkdtempSync(path.join(workRoot, "git-env-"));
  const hooks = path.join(scratch, "hooks");
  fs.mkdirSync(hooks);
  const globalConfig = path.join(scratch, "gitconfig");
  // 空的全局配置：不继承运行机上的 alias / filter / hooksPath / credential helper。
  fs.writeFileSync(globalConfig, "", "utf8");
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_ALLOW_PROTOCOL: allowedProtocols,
    GIT_OPTIONAL_LOCKS: "0",
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  const guard = [
    "-c", `core.hooksPath=${hooks}`,
    "-c", "core.autocrlf=false",
    "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false",
    "-c", "gc.auto=0",
    "-c", "advice.detachedHead=false",
  ];
  return function git(args, cwd) {
    return execFileSync("git", [...guard, ...args], {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
}

function gitExitCode(git, args, cwd) {
  try {
    git(args, cwd);
    return 0;
  } catch (error) {
    return typeof error.status === "number" ? error.status : 1;
  }
}

/** 关键 Git 元数据的指纹：复制前后必须一致，证明 .git 没被投稿内容写入。 */
function gitFingerprint(work) {
  const gitDir = path.join(work, ".git");
  if (!fs.existsSync(gitDir)) throw new Error("工作目录缺少 .git，已中止发布");
  if (!fs.lstatSync(gitDir).isDirectory()) throw new Error("工作目录的 .git 不是目录，已中止发布");
  const parts = [];
  for (const rel of ["config", "HEAD", "packed-refs", "info/attributes", "info/exclude", "hooks"]) {
    const absolute = path.join(gitDir, ...rel.split("/"));
    if (!fs.existsSync(absolute)) {
      parts.push(`${rel}:missing`);
      continue;
    }
    if (fs.lstatSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        const info = fs.lstatSync(path.join(absolute, name));
        parts.push(`${rel}/${name}:${info.size}:${info.mtimeMs}`);
      }
      continue;
    }
    parts.push(`${rel}:${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`);
  }
  return parts.join("\n");
}

function clearWorkTree(work) {
  for (const name of fs.readdirSync(work)) {
    if (name === ".git") continue;
    fs.rmSync(path.join(work, name), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(work, ".git"))) throw new Error("工作目录的 .git 丢失，已中止发布");
}

/**
 * 克隆一个托管仓库到临时目录。工作接口同时供真实实现与测试替身使用：
 * head / branch / files() / setMainBranch() / hasCommit() / isAncestor() /
 * replaceContents() / commitAll() / push() / dispose()。
 */
function createGitWorkspace(url, { workRoot, token, allowedProtocols } = {}) {
  const git = createGitRunner({ workRoot, token, allowedProtocols });
  const work = fs.mkdtempSync(path.join(workRoot, "module-repo-"));
  try {
    git(["clone", "--quiet", `${url}.git`, work], workRoot);
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw new Error(`无法克隆托管仓库 ${url}：${redactSecret(String(error.stderr || error.message).trim(), [token]).slice(-600)}`);
  }
  const run = args => git(args, work);
  let head = null;
  try {
    head = run(["rev-parse", "--verify", "HEAD"]) || null;
  } catch {
    head = null;
  }
  let branch = null;
  if (head) branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    get head() {
      return head;
    },
    get branch() {
      return branch;
    },
    files() {
      return hosting.scanContentTree(work, { skipGitDir: true }).files;
    },
    setMainBranch() {
      run(["symbolic-ref", "HEAD", "refs/heads/main"]);
      branch = "main";
    },
    hasCommit(sha) {
      return gitExitCode(git, ["cat-file", "-e", `${sha}^{commit}`], work) === 0;
    },
    isAncestor(ancestor, descendant) {
      const code = gitExitCode(git, ["merge-base", "--is-ancestor", ancestor, descendant], work);
      if (code === 0) return true;
      if (code === 1) return false;
      throw new Error(`无法判断提交关系：${ancestor} .. ${descendant}`);
    },
    replaceContents(moduleDir, files) {
      const fingerprint = gitFingerprint(work);
      clearWorkTree(work);
      hosting.copyContentTree(files, moduleDir, work);
      if (fs.existsSync(path.join(work, ".git")) && gitFingerprint(work) !== fingerprint) {
        throw new Error("工作目录的 .git 在复制内容时被修改，已中止发布");
      }
    },
    commitAll({ subject, body }) {
      run(["add", "--all"]);
      if (!run(["status", "--porcelain"])) return head;
      run([
        "-c", `user.name=${BOT_NAME}`,
        "-c", `user.email=${BOT_EMAIL}`,
        "commit", "--quiet", "--no-verify",
        "-m", subject,
        "-m", body,
      ]);
      head = run(["rev-parse", "HEAD"]);
      return head;
    },
    push() {
      run(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    },
    dispose() {
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 机器人
// ---------------------------------------------------------------------------

function createBot(options = {}) {
  const root = options.root || ROOT;
  const event = options.event;
  if (!event || !event.issue) throw new Error("createBot 需要 Issues 事件");
  const [owner, repo] = String(options.repository || "").split("/");
  if (!owner || !repo) throw new Error("createBot 需要 owner/repo");
  const issue = event.issue;
  const issueNumber = issue.number;
  const submitterLogin = issue.user && issue.user.login;
  const token = options.token || "";
  const hostingToken = options.hostingToken || "";
  const api = options.api || githubApi;
  const download = options.download || (url => downloadPackage(url));
  const extract = options.extract || (payload => extractPackage(payload));
  const generate = options.generate || ((entries, apiToken) => generateDetails(entries, apiToken));
  const openWorkspace = options.openWorkspace || ((url, extra) => createGitWorkspace(url, extra));
  const now = options.now || (() => new Date());
  const workRoot = options.workRoot || process.env.RUNNER_TEMP || os.tmpdir();
  const log = options.log || ((...args) => console.error(...args));
  const secrets = [token, hostingToken].filter(Boolean);
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  let publishStateCommentId;

  function safe(text, limit) {
    return safeText(text, secrets, limit);
  }

  async function comment(body) {
    await api(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { token, method: "POST", body: { body } });
  }

  async function ensureLabel(name) {
    const existing = await api(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, { token, allow404: true });
    if (!existing) {
      const [color, description] = LABELS[name];
      await api(`/repos/${owner}/${repo}/labels`, { token, method: "POST", body: { name, color, description } });
    }
  }

  async function setStatusLabel(name) {
    for (const label of Object.keys(LABELS)) await ensureLabel(label);
    const liveIssue = await api(`/repos/${owner}/${repo}/issues/${issueNumber}`, { token });
    const current = new Set(((liveIssue && liveIssue.labels) || []).map(label => label.name));
    for (const label of STATUS_LABELS) {
      if (label !== name && current.has(label)) {
        await api(`/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, { token, method: "DELETE", allow404: true });
      }
    }
    await api(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { token, method: "POST", body: { labels: ["content-pack-submission", name] } });
  }

  async function isMaintainer(login) {
    if (!login) return false;
    const result = await api(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { token, allow404: true });
    return ["admin", "maintain", "write"].includes(result ? result.permission : "none");
  }

  async function requireMaintainer() {
    const login = event.comment && event.comment.user && event.comment.user.login;
    if (!(await isMaintainer(login))) throw new Error("只有仓库维护者可以执行此命令");
    return login;
  }

  async function listComments() {
    const all = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await api(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`, { token });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  /**
   * APPROVE-1：只认机器人自己写的最近一条检查结果；更早的成功记录不能盖过
   * 之后失败的检查，分页也会取全（超过 100 条评论时不会看漏）。
   */
  async function latestValidation() {
    const comments = await listComments();
    let outcome = null;
    for (const item of comments) {
      if (!item.user || item.user.login !== BOT_LOGIN) continue;
      const body = String(item.body || "");
      const marker = hosting.decodeMarker(body);
      if (marker) {
        outcome = { state: "validated", marker };
        continue;
      }
      if (body.includes(hosting.VALIDATION_FAILED_MARKER) || /##\s*❌\s*自动检查失败/.test(body)) {
        outcome = { state: "failed" };
      }
    }
    if (!outcome) throw new Error("找不到有效的自动检查记录，请先回复 /recheck");
    if (outcome.state !== "validated") throw new Error("最近一次自动检查没有通过；请修改后回复 /recheck，通过后再由维护者批准");
    return outcome.marker;
  }

  function publishStateBody(state) {
    const step = {
      publishing: "正在创建仓库并推送内容",
      pushed: "内容已推送，准备发布 Release",
      released: "Release 已发布，准备更新索引",
      indexed: "索引已更新",
    }[state.status] || state.status;
    const marker = `<!-- diceframe-content-publish:${hosting.encodePublishState(state)} -->`;
    return [
      "## 🚚 托管发布状态 / Hosting status",
      "",
      `- 插件：\`${state.id}\` \`${state.version}\``,
      `- 托管仓库：${state.repository}`,
      `- 当前步骤：${step}`,
      state.commit_sha ? `- 提交：\`${state.commit_sha}\`` : "",
      state.release_tag ? `- Release：\`${state.release_tag}\`` : "",
      "",
      "这条评论由机器人更新；再次回复 `/approve` 会从当前状态继续，不会重复发布。",
      "",
      marker,
    ].join("\n");
  }

  async function savePublishState(state) {
    const payload = { ...state, updated_at: now().toISOString() };
    const body = publishStateBody(payload);
    try {
      if (publishStateCommentId === undefined) {
        const comments = await listComments();
        const existing = comments.find(item => item.user && item.user.login === BOT_LOGIN && hosting.decodePublishState(item.body));
        publishStateCommentId = existing ? existing.id : null;
      }
      if (publishStateCommentId) {
        await api(`/repos/${owner}/${repo}/issues/comments/${publishStateCommentId}`, { token, method: "PATCH", body: { body } });
        return;
      }
      const created = await api(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { token, method: "POST", body: { body } });
      publishStateCommentId = created && created.id ? created.id : null;
    } catch (error) {
      // 状态评论只是给人看和排查用的；写不进去不能挡住发布本身。
      log(`publish state comment failed: ${redactSecret(error.message, secrets)}`);
    }
  }

  function currentVersion(entry) {
    const details = readJson(path.join(root, "plugin_details.json"));
    const detail = details.find(item => item.id === entry.id) || {};
    return String((detail.latest && detail.latest.version) || (detail.manifest && detail.manifest.version) ||
      String(entry.approved_release_tag || "").replace(/^v/, ""));
  }

  /** 下载 + 校验 + 套索引规则；不碰 Git、不建仓库。 */
  async function inspect(submission, context = {}) {
    const submitter = context.submitter || submitterLogin;
    const maintainer = Boolean(context.maintainer);
    if (!submission.id) throw new Error("请填写插件 ID");
    const repository = hosting.hostedRepository(submission.id);
    const attachment = hosting.singleAttachment(submission);
    const license = hosting.licenseChoice(submission.license);
    const entries = readJson(path.join(root, "plugins.json"));
    const { mode, entry } = hosting.submissionMode(entries, submission.id, submitter, maintainer);

    const payload = await download(attachment);
    const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    const { report, moduleDir } = await extract(payload);
    const pkg = hosting.checkPackageReport(report, { id: submission.id, license });
    const manifest = readJson(path.join(moduleDir, "plugin.json"));
    const policy = validateManifest(manifest, submission.id, repository.url);
    if (policy.riskLevel !== "declarative") throw new Error("这个表单只收不含可执行程序的内容包");
    const permissions = effectivePermissions(manifest, readConfigSchema(moduleDir, manifest));

    const author = submission.author || (entry && entry.author) || submitter;
    const submittedBy = (entry && entry.submitted_by) || submitter;
    if (!pkg.has_license) {
      const text = hosting.licenseFileText({ license, author, name: manifest.name, year: now().getUTCFullYear() });
      fs.writeFileSync(path.join(moduleDir, "LICENSE"), text, "utf8");
    }
    // SEC-1：任何 Git 操作之前先确认待发布内容里没有 Git 元数据、符号链接。
    const plan = hosting.scanContentTree(moduleDir);

    const resumePublished = mode === "update" && entry.approved_release_tag === `v${manifest.version}`;
    if (mode === "update" && !resumePublished) {
      const current = currentVersion(entry);
      if (hosting.compareVersions(manifest.version, current) <= 0) {
        throw new Error(`新版本号 ${manifest.version} 必须高于已收录的 ${current}`);
      }
    }

    const marker = {
      mode,
      id: submission.id,
      name: manifest.name,
      version: manifest.version,
      sha256,
      attachment_url: attachment,
      // 包里自带 LICENSE 时以包为准，不再生成。
      license_label: pkg.has_license ? hosting.INCLUDED_LICENSE : license.label,
      license_spdx: pkg.has_license ? "" : license.spdx,
      author,
      submitted_by: submittedBy,
      risk_level: policy.riskLevel,
      update_policy: policy.updatePolicy,
      permissions,
    };
    return { marker, manifest, moduleDir, plan, report, repository, license, pkg, entry, mode, resumePublished };
  }

  function summaryComment(result) {
    const { marker, manifest, report, repository, mode, resumePublished } = result;
    const profile = manifest.content_profile === "adventure-module" ? "冒险模组" : "内容包";
    const adventures = Array.isArray(report.adventures) ? report.adventures.length : 0;
    const hostingLine = mode === "update"
      ? `更新 [${repository.owner}/${repository.repo}](${repository.url})`
      : `批准后创建 \`${repository.owner}/${repository.repo}\``;
    const warnings = (Array.isArray(report.warnings) ? report.warnings : [])
      .map(item => `- \`${tableCell(item, secrets)}\``)
      .join("\n");
    return [
      "## ✅ 自动检查通过 / Validation passed",
      "",
      "| 项目 | 结果 |",
      "|---|---|",
      `| 内容包 | \`${tableCell(marker.id, secrets)}\` ${tableCell(marker.name, secrets)} |`,
      `| 类型 | ${profile}，${adventures} 个冒险 |`,
      `| 版本 | \`${tableCell(marker.version, secrets)}\` |`,
      `| 作者署名 | ${tableCell(marker.author, secrets)} |`,
      `| 许可证 | ${tableCell(marker.license_label, secrets)} |`,
      `| 托管仓库 | ${hostingLine} |`,
      `| 权限 | ${marker.permissions.length ? marker.permissions.map(item => `\`${tableCell(item, secrets)}\``).join(", ") : "无"} |`,
      `| SHA-256 | \`${marker.sha256}\` |`,
      "",
      resumePublished ? `这个版本已经收录在索引里；再次 \`/approve\` 只会补齐状态，不会重复发布。\n` : "",
      warnings ? `校验提示：\n\n${warnings}\n` : "",
      "自动检查只证明格式和机器可验证条件合格，不代表内容质量或版权已经核实。维护者确认后回复 `/approve`；拒绝请回复 `/reject 原因`。",
      "",
      `<!-- diceframe-content-validation:${hosting.encodeMarker(marker)} -->`,
    ].join("\n");
  }

  async function validate() {
    if (!hosting.CONTENT_TITLE_RE.test(String(issue.title || ""))) return { status: "skipped" };
    if (event.comment && !RECHECK_COMMENT_RE.test(String(event.comment.body || "").trim())) return { status: "skipped" };
    const submitter = submitterLogin;
    if (event.comment) {
      const login = event.comment.user.login;
      if (login !== submitter && !(await isMaintainer(login))) throw new Error("只有投稿者或维护者可以重新检查");
    }
    await setStatusLabel("pending-validation");
    try {
      const submission = hosting.parseContentSubmission(issue.body);
      const result = await inspect(submission, { submitter, maintainer: await isMaintainer(submitter) });
      await setStatusLabel("validated");
      await comment(summaryComment(result));
      return { status: "passed", marker: result.marker };
    } catch (error) {
      log(redactSecret(error.stack || error.message, secrets));
      await setStatusLabel("validation-failed");
      await comment([
        "## ❌ 自动检查失败 / Validation failed",
        "",
        safe(error.message),
        "",
        hosting.VALIDATION_FAILED_MARKER,
        "",
        "修改后编辑这条 Issue 重新上传，或回复 `/recheck`。",
      ].join("\n"));
      return { status: "failed" };
    }
  }

  /**
   * PUB-1：仓库存在时先证明它就是这次投稿（或索引记录）的仓库。
   * 不能只凭“没有 Release”就复用同名组织仓库。
   */
  async function hostedRepositoryState(result) {
    const { repository, mode, entry } = result;
    const repoPath = `/repos/${repository.owner}/${repository.repo}`;
    const info = await api(repoPath, { token: hostingToken, allow404: true });
    if (!info) return { state: "create" };
    const expected = `${repository.owner}/${repository.repo}`.toLowerCase();
    if (String(info.full_name || "").toLowerCase() !== expected) {
      throw new Error(`同名仓库 ${info.full_name || "<unknown>"} 与预期的 ${repository.owner}/${repository.repo} 不一致，已中止；请维护者手动处理`);
    }
    if (info.private) throw new Error(`托管仓库 ${repository.repo} 是私有仓库，已中止；请维护者手动处理`);
    if (info.archived || info.disabled) throw new Error(`托管仓库 ${repository.repo} 已归档或禁用，已中止；请维护者手动处理`);
    if (info.fork) throw new Error(`托管仓库 ${repository.repo} 是 fork，已中止；请维护者手动处理`);
    if (String(info.default_branch || "main") !== "main") {
      throw new Error(`托管仓库 ${repository.repo} 的默认分支不是 main，已中止；请维护者手动处理`);
    }
    if (mode === "new") {
      // 只有创建时写入本次 Issue 地址的仓库才算“同一次投稿”。
      const homepage = String(info.homepage || "").trim().replace(/\/+$/, "");
      if (homepage !== issueUrl) {
        throw new Error(`仓库 ${repository.owner}/${repository.repo} 已存在，但不是本次投稿（#${issueNumber}）创建的，拒绝复用或覆盖；请维护者手动处理`);
      }
      return { state: "resume", info };
    }
    hosting.assertHostedEntryIdentity(entry, result.marker.id);
    if (entry.submitted_by !== result.marker.submitted_by) {
      throw new Error("索引记录的投稿者与本次投稿不一致，已中止；请维护者手动处理");
    }
    const release = await api(`${repoPath}/releases/tags/${encodeURIComponent(entry.approved_release_tag)}`, { token: hostingToken, allow404: true });
    if (!release) {
      throw new Error(`托管仓库 ${repository.repo} 缺少已批准的 Release ${entry.approved_release_tag}，已中止；请维护者手动处理`);
    }
    const releaseCommit = await api(`${repoPath}/commits/${encodeURIComponent(entry.approved_release_tag)}`, { token: hostingToken });
    if (String((releaseCommit && releaseCommit.sha) || "").toLowerCase() !== String(entry.approved_commit).toLowerCase()) {
      throw new Error(`托管仓库 ${repository.repo} 的 ${entry.approved_release_tag} 指向的提交与索引记录不一致，已中止；请维护者手动处理`);
    }
    return { state: "update", info };
  }

  async function createRepository(repository, manifest, marker) {
    const repoPath = `/repos/${repository.owner}/${repository.repo}`;
    const existing = await api(repoPath, { token: hostingToken, allow404: true });
    if (existing) return;
    try {
      await api(`/orgs/${repository.owner}/repos`, {
        token: hostingToken,
        method: "POST",
        body: {
          name: repository.repo,
          description: `${manifest.name}｜DiceFrame 内容包，作者 ${marker.author}`.replace(/\s+/g, " ").slice(0, 350),
          homepage: issueUrl,
          private: false,
          has_issues: true,
          has_projects: false,
          has_wiki: false,
          auto_init: false,
        },
      });
    } catch (error) {
      // 并发下可能刚被另一个运行创建；确认存在后继续，其余错误原样抛出。
      const created = await api(repoPath, { token: hostingToken, allow404: true });
      if (!created) throw error;
    }
  }

  /** 推送内容；只提交经过 scanContentTree 验证的普通文件，绝不写 .git。 */
  async function publish({ repository, moduleDir, plan, marker, entry, mode }) {
    const workspace = await openWorkspace(repository.url, { token: hostingToken, workRoot });
    try {
      if (workspace.head) {
        if (workspace.branch !== "main") {
          throw new Error(`托管仓库 ${repository.repo} 的默认分支不是 main，已中止；请维护者手动处理`);
        }
        if (mode === "update") {
          const approved = String(entry.approved_commit).toLowerCase();
          const head = String(workspace.head).toLowerCase();
          const contentMatches = hosting.sameContent(workspace.files(), plan.files);
          if (head !== approved && !contentMatches) {
            throw new Error(`托管仓库 ${repository.repo} 的 main 分支有未预期的提交（${workspace.head}），已中止；请维护者手动处理`);
          }
          if (!workspace.hasCommit(approved) || !workspace.isAncestor(approved, head)) {
            throw new Error(`托管仓库 ${repository.repo} 的历史里找不到已批准的提交 ${entry.approved_commit}，已中止；请维护者手动处理`);
          }
        }
      } else {
        workspace.setMainBranch();
      }
      workspace.replaceContents(moduleDir, plan.files);
      const commitSha = await workspace.commitAll({
        subject: `Release v${marker.version}`,
        body: `Submitted in ${owner}/${repo}#${issueNumber} by ${submitterLogin}.`,
      });
      if (!commitSha) throw new Error("托管仓库没有产生提交，已中止");
      await workspace.push();
      return commitSha;
    } finally {
      workspace.dispose();
    }
  }

  /** 已收录版本的重新批准：只确认仓库内容就是这次附件，不产生新提交。 */
  async function verifyPublishedRepository({ repository, plan, entry, marker }) {
    const workspace = await openWorkspace(repository.url, { token: hostingToken, workRoot });
    try {
      if (workspace.branch !== "main") {
        throw new Error(`托管仓库 ${repository.repo} 的默认分支不是 main，已中止；请维护者手动处理`);
      }
      if (String(workspace.head || "").toLowerCase() !== String(entry.approved_commit).toLowerCase()) {
        throw new Error(`托管仓库 ${repository.repo} 的 main 已不是已批准的提交，已中止；请维护者手动处理`);
      }
      if (!hosting.sameContent(workspace.files(), plan.files)) {
        throw new Error(`已经发布的 ${marker.version} 与本次附件内容不同；请提高版本号后重新投稿`);
      }
      return workspace.head;
    } finally {
      workspace.dispose();
    }
  }

  async function createRelease(repository, marker, commitSha) {
    const tag = `v${marker.version}`;
    const base = `/repos/${repository.owner}/${repository.repo}`;
    const existing = await api(`${base}/releases/tags/${encodeURIComponent(tag)}`, { token: hostingToken, allow404: true });
    if (existing) {
      // 上次批准已经发布过同一个提交：直接沿用，绝不覆盖指向别的提交的 tag。
      const commit = await api(`${base}/commits/${encodeURIComponent(tag)}`, { token: hostingToken });
      if (String((commit && commit.sha) || "").toLowerCase() !== String(commitSha).toLowerCase()) {
        throw new Error(`托管仓库已有 ${tag}，但指向别的提交，已中止；请维护者手动处理`);
      }
      return { tag, commitSha, url: existing.html_url || "" };
    }
    let created;
    // 已有同名 tag 但指向别的提交：绝不覆盖，也不让 GitHub 返回含义不明的 422。
    const existingTag = await api(`${base}/git/ref/tags/${encodeURIComponent(tag)}`, { token: hostingToken, allow404: true });
    if (existingTag && existingTag.object && existingTag.object.type === "commit" &&
      String(existingTag.object.sha || "").toLowerCase() !== String(commitSha).toLowerCase()) {
      throw new Error(`托管仓库已有 tag ${tag} 指向别的提交，已中止；请维护者手动处理`);
    }
    try {
      created = await api(`${base}/releases`, {
        token: hostingToken,
        method: "POST",
        body: {
          tag_name: tag,
          target_commitish: commitSha,
          name: tag,
          body: `作者：${marker.author}\n投稿：${issueUrl}`,
          draft: false,
          prerelease: false,
        },
      });
    } catch (error) {
      throw new Error(`发布 ${tag} 失败：${redactSecret(error.message, secrets)}`);
    }
    return { tag, commitSha, url: (created && created.html_url) || "" };
  }

  async function writeIndex(marker, release, approvedBy) {
    const entriesPath = path.join(root, "plugins.json");
    const entries = readJson(entriesPath);
    const index = entries.findIndex(item => item.id === marker.id);
    const approval = { by: approvedBy, at: now().toISOString() };
    if (marker.mode === "new") {
      if (index >= 0) throw new Error(`插件 ID 已存在：${marker.id}`);
      entries.push(hosting.hostedEntry(marker, release, approval));
    } else {
      if (index < 0) throw new Error(`索引里找不到插件 ${marker.id}，请维护者手动处理`);
      entries[index] = hosting.updatedHostedEntry(entries[index], marker, release, approval);
    }
    entries.sort((left, right) => left.id.localeCompare(right.id));
    writeJson(entriesPath, entries);
    const generated = await generate(entries, token);
    writeJson(path.join(root, "plugin_details.json"), generated.details);
    // COMPAT-1：详情必须可安装且对应本次投稿，否则不能当作批准成功。
    const detail = (generated.details || []).find(item => item && item.id === marker.id);
    hosting.verifyPublishedDetail(detail, marker, release);
    return entries;
  }

  function publishOutputs(marker, approvedBy) {
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `plugin_id=${marker.id}\nversion=${marker.version}\nmode=${marker.mode}\napproved_by=${approvedBy}\n`,
        "utf8",
      );
    }
    return { status: "approved", pluginId: marker.id, version: marker.version, mode: marker.mode, approvedBy };
  }

  async function approve() {
    if (!event.comment || !APPROVE_COMMENT_RE.test(String(event.comment.body || "").trim())) return { status: "skipped" };
    const approvedBy = await requireMaintainer();
    if (!hostingToken) throw new Error("仓库没有配置 CONTENT_HOSTING_TOKEN，无法创建托管仓库");
    const checked = await latestValidation();
    const submission = hosting.parseContentSubmission(issue.body);
    const result = await inspect(submission, { submitter: submitterLogin, maintainer: await isMaintainer(submitterLogin) });
    if (result.marker.sha256 !== checked.sha256) {
      throw new Error("附件内容在检查后发生变化，请先回复 /recheck，再请维护者批准");
    }
    const changed = hosting.diffSnapshots(checked, result.marker);
    if (changed.length) {
      const names = changed.map(key => hosting.SNAPSHOT_LABELS[key] || key).join("、");
      throw new Error(`投稿在检查后发生了变化（${names}），请先回复 /recheck，再请维护者批准`);
    }

    const { marker, manifest, moduleDir, plan, repository, entry, mode } = result;
    const state = await hostedRepositoryState(result);
    if (mode === "new" && state.state === "create") {
      await createRepository(repository, manifest, marker);
    }

    const baseState = {
      id: marker.id,
      version: marker.version,
      sha256: marker.sha256,
      repository: `${repository.owner}/${repository.repo}`,
      approved_by: approvedBy,
    };

    if (result.resumePublished) {
      const commitSha = await verifyPublishedRepository({ repository, plan, entry, marker });
      const release = await createRelease(repository, marker, commitSha);
      await savePublishState({ ...baseState, commit_sha: commitSha, release_tag: release.tag, status: "indexed" });
      return publishOutputs(marker, approvedBy);
    }

    await savePublishState({ ...baseState, commit_sha: "", release_tag: "", status: "publishing" });
    const commitSha = await publish({ repository, moduleDir, plan, marker, entry, mode });
    await savePublishState({ ...baseState, commit_sha: commitSha, release_tag: "", status: "pushed" });
    const release = await createRelease(repository, marker, commitSha);
    await savePublishState({ ...baseState, commit_sha: commitSha, release_tag: release.tag, status: "released" });
    await writeIndex(marker, release, approvedBy);
    await savePublishState({ ...baseState, commit_sha: commitSha, release_tag: release.tag, status: "indexed" });
    return publishOutputs(marker, approvedBy);
  }

  async function readRepoJson(file) {
    const data = await api(`/repos/${owner}/${repo}/contents/${file}?ref=main`, { token });
    if (!data || data.type !== "file" || data.encoding !== "base64") throw new Error(`${file} 不是普通文件`);
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  }

  /** PUB-2：只有确认主分支索引已更新、详情可安装，才关闭 Issue。 */
  async function finish() {
    const pluginId = String(process.env.PLUGIN_ID || "").trim();
    const version = String(process.env.PLUGIN_VERSION || "").trim();
    const approvedBy = String(process.env.APPROVED_BY || "").trim();
    if (!pluginId || !version) throw new Error("缺少 PLUGIN_ID / PLUGIN_VERSION，无法确认发布结果");
    const repository = hosting.hostedRepository(pluginId);
    const entries = await readRepoJson("plugins.json");
    const details = await readRepoJson("plugin_details.json");
    const entry = (Array.isArray(entries) ? entries : []).find(item => item && item.id === pluginId);
    if (!entry) throw new Error(`main 分支的索引里还没有 ${pluginId}；请确认索引提交已经推送后再回复 /approve`);
    hosting.assertHostedEntryIdentity(entry, pluginId);
    const tag = `v${version}`;
    if (entry.approved_release_tag !== tag) {
      throw new Error(`索引记录的 Release 是 ${entry.approved_release_tag}，不是本次批准的 ${tag}`);
    }
    const detail = (Array.isArray(details) ? details : []).find(item => item && item.id === pluginId);
    hosting.verifyPublishedDetail(
      detail,
      { id: pluginId, version, author: entry.author, license_spdx: entry.license || "" },
      { tag, commitSha: entry.approved_commit },
    );
    // 再核对托管仓库里的 Release 确实指向被批准的提交（需要组织凭据才读得到）。
    if (hostingToken) {
      const repoPath = `/repos/${repository.owner}/${repository.repo}`;
      const release = await api(`${repoPath}/releases/tags/${encodeURIComponent(tag)}`, { token: hostingToken, allow404: true });
      if (!release) throw new Error(`托管仓库 ${repository.repo} 里找不到 Release ${tag}`);
      const commit = await api(`${repoPath}/commits/${encodeURIComponent(tag)}`, { token: hostingToken });
      if (String((commit && commit.sha) || "").toLowerCase() !== String(entry.approved_commit).toLowerCase()) {
        throw new Error(`Release ${tag} 指向的提交与索引记录不一致`);
      }
    }

    const liveIssue = await api(`/repos/${owner}/${repo}/issues/${issueNumber}`, { token });
    const labels = new Set(((liveIssue && liveIssue.labels) || []).map(item => item.name));
    if (liveIssue && liveIssue.state === "closed" && labels.has("approved")) return { status: "already-finished" };
    await setStatusLabel("approved");
    const action = process.env.SUBMISSION_MODE === "update" ? "已更新" : "已收录";
    await comment(`## ✅ ${action} / Approved\n\n内容包 \`${pluginId}\` \`${version}\` 已由 @${approvedBy} 批准，托管在 [${repository.owner}/${repository.repo}](${repository.url})，DiceFrame 的「在线内容包」里可以安装了。\n\n以后要更新，用「投稿内容包」表单再投一次更高版本号的包即可。`);
    await api(`/repos/${owner}/${repo}/issues/${issueNumber}`, { token, method: "PATCH", body: { state: "closed" } });
    return { status: "finished" };
  }

  async function reject() {
    if (!event.comment || !REJECT_COMMENT_RE.test(String(event.comment.body || "").trim())) return { status: "skipped" };
    const rejectedBy = await requireMaintainer();
    const reason = safe(String(event.comment.body || "").trim().replace(/^\/reject\s*/i, "").trim() || "未提供原因");
    await setStatusLabel("rejected");
    await comment(`## ❌ 未收录 / Rejected\n\n维护者：@${rejectedBy}\n\n原因：${reason}`);
    await api(`/repos/${owner}/${repo}/issues/${issueNumber}`, { token, method: "PATCH", body: { state: "closed" } });
    return { status: "rejected" };
  }

  return {
    approve,
    comment,
    finish,
    inspect,
    latestValidation,
    listComments,
    publish,
    reject,
    savePublishState,
    summaryComment,
    validate,
  };
}

function main(argv = process.argv) {
  const command = argv[2];
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("缺少 GITHUB_EVENT_PATH");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const bot = createBot({
    event,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN || "",
    hostingToken: process.env.CONTENT_HOSTING_TOKEN || "",
    workRoot: process.env.RUNNER_TEMP || os.tmpdir(),
  });
  const commands = { validate: bot.validate, approve: bot.approve, finish: bot.finish, reject: bot.reject };
  const run = commands[command];
  if (!run) throw new Error(`Unknown command: ${command}`);
  return Promise.resolve()
    .then(run)
    .then(result => {
      if (result && result.status === "failed") process.exitCode = 1;
      return result;
    })
    .catch(async error => {
      console.error(redactSecret(error.stack || error.message, [process.env.GITHUB_TOKEN, process.env.CONTENT_HOSTING_TOKEN]));
      if (command === "approve" || command === "finish") {
        const text = safeText(error.message, [process.env.GITHUB_TOKEN, process.env.CONTENT_HOSTING_TOKEN]);
        await bot.comment(`## ❌ 批准流程未完成\n\n${text}\n\n修正后可以再次回复 \`/approve\`；已经完成的步骤不会重复执行。`).catch(() => {});
      }
      process.exitCode = 1;
      return null;
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  BOT_EMAIL,
  BOT_LOGIN,
  BOT_NAME,
  clearWorkTree,
  createBot,
  createGitRunner,
  createGitWorkspace,
  downloadPackage,
  extractPackage,
  gitFingerprint,
  main,
  redactSecret,
  safeText,
  tableCell,
};
