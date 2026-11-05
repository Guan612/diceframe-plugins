"use strict";

// 内容包投稿机器人：校验 Issue 里上传的 .zip，维护者 /approve 后在 diceframe 组织下
// 建 module-<插件 ID> 仓库、推送内容、发布 Release，并写入索引。
// 解压与内容校验交给 DiceFrame 自己的 scripts/validate_content_module.py（与安装同一套规则）。

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
const EVENT = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const [OWNER, REPO] = String(process.env.GITHUB_REPOSITORY || "").split("/");
const TOKEN = process.env.GITHUB_TOKEN || "";
const HOSTING_TOKEN = process.env.CONTENT_HOSTING_TOKEN || "";
const DICEFRAME_ROOT = process.env.DICEFRAME_ROOT || "";
const PYTHON = process.env.PYTHON || "python";
const WORK_ROOT = process.env.RUNNER_TEMP || os.tmpdir();
const ISSUE = EVENT.issue;
const ISSUE_NUMBER = ISSUE.number;
const STATUS_LABELS = ["pending-validation", "validated", "validation-failed", "approved", "rejected"];
const LABELS = {
  "content-pack-submission": ["8250df", "Content pack submission"],
  "pending-validation": ["d4c5f9", "Waiting for automated validation"],
  "validated": ["0e8a16", "Automated validation passed"],
  "validation-failed": ["d73a4a", "Automated validation failed"],
  "approved": ["1d76db", "Approved and added to the registry"],
  "rejected": ["b60205", "Rejected by a maintainer"],
};
const BOT_NAME = "diceframe-registry[bot]";
const BOT_EMAIL = "diceframe-registry[bot]@users.noreply.github.com";

async function comment(body) {
  await githubApi(`/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments`, { token: TOKEN, method: "POST", body: { body } });
}

async function ensureLabel(name) {
  const existing = await githubApi(`/repos/${OWNER}/${REPO}/labels/${encodeURIComponent(name)}`, { token: TOKEN, allow404: true });
  if (!existing) {
    const [color, description] = LABELS[name];
    await githubApi(`/repos/${OWNER}/${REPO}/labels`, { token: TOKEN, method: "POST", body: { name, color, description } });
  }
}

async function setStatusLabel(name) {
  for (const label of Object.keys(LABELS)) await ensureLabel(label);
  const liveIssue = await githubApi(`/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`, { token: TOKEN });
  const current = new Set((liveIssue.labels || []).map(label => label.name));
  for (const label of STATUS_LABELS) {
    if (label !== name && current.has(label)) {
      await githubApi(`/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/labels/${encodeURIComponent(label)}`, { token: TOKEN, method: "DELETE", allow404: true });
    }
  }
  await githubApi(`/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/labels`, { token: TOKEN, method: "POST", body: { labels: ["content-pack-submission", name] } });
}

async function isMaintainer(login) {
  const result = await githubApi(`/repos/${OWNER}/${REPO}/collaborators/${encodeURIComponent(login)}/permission`, { token: TOKEN, allow404: true });
  return ["admin", "maintain", "write"].includes(result ? result.permission : "none");
}

async function requireMaintainer() {
  const login = EVENT.comment.user.login;
  if (!(await isMaintainer(login))) throw new Error("只有仓库维护者可以执行此命令");
  return login;
}

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

function runValidator(payload) {
  if (!DICEFRAME_ROOT) throw new Error("DICEFRAME_ROOT 未设置，找不到 DiceFrame 校验器");
  const work = fs.mkdtempSync(path.join(WORK_ROOT, "content-pack-"));
  const archive = path.join(work, "package.zip");
  const moduleDir = path.join(work, "module");
  fs.writeFileSync(archive, payload);
  const script = path.join(DICEFRAME_ROOT, "scripts", "validate_content_module.py");
  let stdout;
  try {
    stdout = execFileSync(PYTHON, ["-I", script, archive, "--json", "--extract-to", moduleDir], {
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

function currentVersion(entry) {
  const details = readJson(path.join(ROOT, "plugin_details.json"));
  const detail = details.find(item => item.id === entry.id) || {};
  return String((detail.latest && detail.latest.version) || (detail.manifest && detail.manifest.version) ||
    String(entry.approved_release_tag || "").replace(/^v/, ""));
}

async function ensureRepositoryAvailable(repository) {
  const existing = await githubApi(`/repos/${repository.owner}/${repository.repo}`, { token: TOKEN, allow404: true });
  if (!existing) return "create";
  // 上次批准中途失败会留下一个还没发布过的空仓库，允许接着用。
  const releases = await githubApi(`/repos/${repository.owner}/${repository.repo}/releases?per_page=1`, { token: TOKEN });
  if (Array.isArray(releases) && releases.length) {
    throw new Error(`仓库 ${repository.owner}/${repository.repo} 已存在且发布过版本，请换一个插件 ID 或联系维护者`);
  }
  return "reuse";
}

/** Download, validate and summarize a submission; used by both validate and approve. */
async function inspect(submission, { submitter, maintainer }) {
  if (!submission.id) throw new Error("请填写插件 ID");
  const repository = hosting.hostedRepository(submission.id);
  const attachment = hosting.singleAttachment(submission);
  const license = hosting.licenseChoice(submission.license);
  const entries = readJson(path.join(ROOT, "plugins.json"));
  const { mode, entry } = hosting.submissionMode(entries, submission.id, submitter, maintainer);
  const repositoryState = mode === "new" ? await ensureRepositoryAvailable(repository) : "update";

  const payload = await downloadPackage(attachment);
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const { report, moduleDir } = runValidator(payload);
  const pkg = hosting.checkPackageReport(report, { id: submission.id, license });
  const manifest = readJson(path.join(moduleDir, "plugin.json"));
  const policy = validateManifest(manifest, submission.id, repository.url);
  if (policy.riskLevel !== "declarative") throw new Error("这个表单只收不含可执行程序的内容包");
  const permissions = effectivePermissions(manifest, readConfigSchema(moduleDir, manifest));
  if (mode === "update") {
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
    author: submission.author || (entry && entry.author) || submitter,
    submitted_by: entry ? entry.submitted_by : submitter,
    risk_level: policy.riskLevel,
    update_policy: policy.updatePolicy,
    permissions,
  };
  return { marker, manifest, moduleDir, report, repository, repositoryState, license, pkg };
}

function summaryComment(result) {
  const { marker, manifest, report, repository, repositoryState } = result;
  const profile = manifest.content_profile === "adventure-module" ? "冒险模组" : "内容包";
  const adventures = Array.isArray(report.adventures) ? report.adventures.length : 0;
  const hostingLine = repositoryState === "update"
    ? `更新 [${repository.owner}/${repository.repo}](${repository.url})`
    : `批准后创建 \`${repository.owner}/${repository.repo}\``;
  const warnings = (report.warnings || []).map(item => `- \`${item}\``).join("\n");
  const encoded = hosting.encodeMarker(marker);
  return [
    "## ✅ 自动检查通过 / Validation passed",
    "",
    "| 项目 | 结果 |",
    "|---|---|",
    `| 内容包 | \`${marker.id}\` ${manifest.name} |`,
    `| 类型 | ${profile}，${adventures} 个冒险 |`,
    `| 版本 | \`${marker.version}\` |`,
    `| 作者署名 | ${marker.author} |`,
    `| 许可证 | ${marker.license_label} |`,
    `| 托管仓库 | ${hostingLine} |`,
    `| 权限 | ${marker.permissions.length ? marker.permissions.map(item => `\`${item}\``).join(", ") : "无"} |`,
    `| SHA-256 | \`${marker.sha256}\` |`,
    "",
    warnings ? `校验提示：\n\n${warnings}\n` : "",
    "自动检查只证明格式和机器可验证条件合格，不代表内容质量或版权已经核实。维护者确认后回复 `/approve`；拒绝请回复 `/reject 原因`。",
    "",
    `<!-- diceframe-content-validation:${encoded} -->`,
  ].join("\n");
}

async function validate() {
  if (!hosting.CONTENT_TITLE_RE.test(ISSUE.title)) return;
  if (EVENT.comment && !/^\/recheck\s*$/i.test(EVENT.comment.body.trim())) return;
  const submitter = ISSUE.user.login;
  if (EVENT.comment) {
    const login = EVENT.comment.user.login;
    if (login !== submitter && !(await isMaintainer(login))) throw new Error("只有投稿者或维护者可以重新检查");
  }
  await setStatusLabel("pending-validation");
  try {
    const submission = hosting.parseContentSubmission(ISSUE.body);
    const result = await inspect(submission, { submitter, maintainer: await isMaintainer(submitter) });
    await setStatusLabel("validated");
    await comment(summaryComment(result));
  } catch (error) {
    await setStatusLabel("validation-failed");
    await comment(`## ❌ 自动检查失败 / Validation failed\n\n${error.message}\n\n修改后编辑这条 Issue 重新上传，或回复 \`/recheck\`。`);
    process.exitCode = 1;
  }
}

async function latestMarker() {
  const comments = await githubApi(`/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments?per_page=100`, { token: TOKEN });
  for (const item of comments.slice().reverse()) {
    if (item.user && item.user.login === "github-actions[bot]") {
      const marker = hosting.decodeMarker(item.body);
      if (marker) return marker;
    }
  }
  throw new Error("找不到有效的自动检查记录，请先回复 /recheck");
}

function hostingGitEnv() {
  const basic = Buffer.from(`x-access-token:${HOSTING_TOKEN}`).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: hostingGitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function createRepository(repository, manifest, marker) {
  const existing = await githubApi(`/repos/${repository.owner}/${repository.repo}`, { token: HOSTING_TOKEN, allow404: true });
  if (existing) return;
  await githubApi(`/orgs/${repository.owner}/repos`, {
    token: HOSTING_TOKEN,
    method: "POST",
    body: {
      name: repository.repo,
      description: `${manifest.name}｜DiceFrame 内容包，作者 ${marker.author}`.replace(/\s+/g, " ").slice(0, 350),
      homepage: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`,
      private: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    },
  });
}

/** Replace the hosted repository's main branch contents with the validated module; return the commit. */
function publishContents(repository, moduleDir, marker) {
  const work = fs.mkdtempSync(path.join(WORK_ROOT, "module-repo-"));
  git(["clone", "--quiet", `${repository.url}.git`, work], WORK_ROOT);
  let empty = false;
  try {
    git(["rev-parse", "--verify", "HEAD"], work);
  } catch {
    empty = true;
  }
  if (empty) {
    git(["symbolic-ref", "HEAD", "refs/heads/main"], work);
  } else if (git(["rev-parse", "--abbrev-ref", "HEAD"], work) !== "main") {
    throw new Error(`托管仓库 ${repository.repo} 的默认分支不是 main，请维护者手动处理`);
  }
  for (const name of fs.readdirSync(work)) {
    if (name !== ".git") fs.rmSync(path.join(work, name), { recursive: true, force: true });
  }
  fs.cpSync(moduleDir, work, { recursive: true });
  git(["add", "--all"], work);
  if (git(["status", "--porcelain"], work)) {
    git([
      "-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`,
      "commit", "--quiet",
      "-m", `Release v${marker.version}`,
      "-m", `Submitted in ${OWNER}/${REPO}#${ISSUE_NUMBER} by ${ISSUE.user.login}.`,
    ], work);
  }
  git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], work);
  return git(["rev-parse", "HEAD"], work);
}

async function createRelease(repository, marker, commitSha) {
  const tag = `v${marker.version}`;
  const base = `/repos/${repository.owner}/${repository.repo}`;
  const existing = await githubApi(`${base}/releases/tags/${encodeURIComponent(tag)}`, { token: HOSTING_TOKEN, allow404: true });
  if (existing) {
    // 上次批准已经发布过同一个提交：直接沿用。
    const commit = await githubApi(`${base}/commits/${encodeURIComponent(tag)}`, { token: HOSTING_TOKEN });
    if (commit.sha !== commitSha) throw new Error(`托管仓库已有 ${tag}，但指向别的提交，请维护者手动处理`);
    return { tag, commitSha };
  }
  await githubApi(`${base}/releases`, {
    token: HOSTING_TOKEN,
    method: "POST",
    body: {
      tag_name: tag,
      target_commitish: commitSha,
      name: tag,
      body: `作者：${marker.author}\n投稿：https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`,
      draft: false,
      prerelease: false,
    },
  });
  return { tag, commitSha };
}

async function approve() {
  if (!EVENT.comment || !/^\/approve\s*$/i.test(EVENT.comment.body.trim())) return;
  const approvedBy = await requireMaintainer();
  if (!HOSTING_TOKEN) throw new Error("仓库没有配置 CONTENT_HOSTING_TOKEN，无法创建托管仓库");
  const checked = await latestMarker();
  const submission = hosting.parseContentSubmission(ISSUE.body);
  if (checked.id !== submission.id || checked.attachment_url !== hosting.singleAttachment(submission)) {
    throw new Error("投稿内容在检查后发生变化，请先回复 /recheck");
  }
  // 重新下载、重新校验；附件内容必须和检查时完全一致。
  const submitter = ISSUE.user.login;
  const result = await inspect(submission, { submitter, maintainer: await isMaintainer(submitter) });
  const { marker, manifest, moduleDir, repository, license, pkg } = result;
  if (marker.sha256 !== checked.sha256) throw new Error("附件内容在检查后发生变化，请先回复 /recheck");

  if (!pkg.has_license) {
    const text = hosting.licenseFileText({ license, author: marker.author, name: manifest.name, year: new Date().getUTCFullYear() });
    fs.writeFileSync(path.join(moduleDir, "LICENSE"), text, "utf8");
  }
  if (marker.mode === "new") await createRepository(repository, manifest, marker);
  const commitSha = publishContents(repository, moduleDir, marker);
  const release = await createRelease(repository, marker, commitSha);

  const entriesPath = path.join(ROOT, "plugins.json");
  const entries = readJson(entriesPath);
  const approval = { by: approvedBy, at: new Date().toISOString() };
  const index = entries.findIndex(item => item.id === marker.id);
  if (marker.mode === "new") {
    if (index >= 0) throw new Error(`插件 ID 已存在：${marker.id}`);
    entries.push(hosting.hostedEntry(marker, release, approval));
  } else {
    entries[index] = hosting.updatedHostedEntry(entries[index], marker, release, approval);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  writeJson(entriesPath, entries);
  const generated = await generateDetails(entries, TOKEN);
  writeJson(path.join(ROOT, "plugin_details.json"), generated.details);
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `plugin_id=${marker.id}\nversion=${marker.version}\nmode=${marker.mode}\napproved_by=${approvedBy}\n`,
    "utf8",
  );
}

async function finish() {
  const pluginId = process.env.PLUGIN_ID;
  const version = process.env.PLUGIN_VERSION;
  const approvedBy = process.env.APPROVED_BY;
  const repository = hosting.hostedRepository(pluginId);
  const action = process.env.SUBMISSION_MODE === "update" ? "已更新" : "已收录";
  await setStatusLabel("approved");
  await comment(`## ✅ ${action} / Approved\n\n内容包 \`${pluginId}\` \`${version}\` 已由 @${approvedBy} 批准，托管在 [${repository.owner}/${repository.repo}](${repository.url})，DiceFrame 的「在线内容包」里可以安装了。\n\n以后要更新，用「投稿内容包」表单再投一次更高版本号的包即可。`);
  await githubApi(`/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`, { token: TOKEN, method: "PATCH", body: { state: "closed" } });
}

async function reject() {
  if (!EVENT.comment || !/^\/reject(?:\s+[\s\S]+)?$/i.test(EVENT.comment.body.trim())) return;
  const rejectedBy = await requireMaintainer();
  const reason = EVENT.comment.body.trim().replace(/^\/reject\s*/i, "").trim() || "未提供原因";
  await setStatusLabel("rejected");
  await comment(`## ❌ 未收录 / Rejected\n\n维护者：@${rejectedBy}\n\n原因：${reason}`);
  await githubApi(`/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`, { token: TOKEN, method: "PATCH", body: { state: "closed" } });
}

const command = process.argv[2];
({ validate, approve, finish, reject }[command] || (() => { throw new Error(`Unknown command: ${command}`); }))()
  .catch(async error => {
    console.error(error.stack || error.message);
    if (command === "approve") await comment(`## ❌ 批准失败\n\n${error.message}`).catch(() => {});
    process.exitCode = 1;
  });
