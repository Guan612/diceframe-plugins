"use strict";

// 内容包投稿托管（没有自己仓库的作者上传 .zip，由 DiceFrame 组织代建仓库发布）。
// 这里只放纯函数，便于测试；读写 GitHub 的流程在 content-submission.cjs。

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PLUGIN_ID_RE, SEMVER_RE, field, normalizeRepositoryUrl } = require("./registry.cjs");

const CONTENT_TITLE_RE = /^\[Content Pack\]/i;
const HOSTING_OWNER = "diceframe";
const HOSTED_REPO_PREFIX = "module-";
// 与 DiceFrame 安装器的 MAX_PLUGIN_PACKAGE_BYTES 一致；GitHub 附件上限是 25 MB。
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const INCLUDED_LICENSE = "包里已有 LICENSE / Included in package";
const LICENSES = {
  "CC BY 4.0": { spdx: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  "CC BY-NC 4.0": { spdx: "CC-BY-NC-4.0", url: "https://creativecommons.org/licenses/by-nc/4.0/" },
  "CC BY-SA 4.0": { spdx: "CC-BY-SA-4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
  "CC0 1.0": { spdx: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  "MIT": { spdx: "MIT", url: "https://opensource.org/license/mit" },
};
const LICENSES_DIR = path.resolve(__dirname, "..", "licenses");
// 只接受 GitHub 自己的附件地址，不下载任意外部链接。
const ATTACHMENT_RE = /https:\/\/github\.com\/(?:user-attachments\/files|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/files)\/\d+\/[^\s)<>"']+/g;

// 投稿内容里绝对不能出现的名字：Git 元数据、Git 属性/忽略规则、CI 配置。
// 这些文件能改变发布进程（钩子、过滤器、编码转换、子模块、LFS、默认工作流），
// 只能由维护者控制的流程产生，不能来自不可信 ZIP。比较时忽略大小写和结尾的点/空格
// （Windows 与大小写不敏感文件系统会把它们折叠成同一个名字）。
const PROTECTED_NAMES = new Set([
  ".git", ".gitattributes", ".gitignore", ".gitmodules", ".gitconfig", ".git-credentials",
  ".lfsconfig", ".github", ".gitlab", ".gitlab-ci.yml", ".circleci", ".travis.yml",
  ".appveyor.yml", "appveyor.yml", "azure-pipelines.yml",
]);
const MAX_PUBLISH_FILES = 4096;
const MAX_PUBLISH_BYTES = 100 * 1024 * 1024;
// 审核快照字段：批准时必须与自动检查时完全一致。
const SNAPSHOT_FIELDS = [
  "id", "name", "version", "sha256", "attachment_url", "author", "submitted_by",
  "license_label", "license_spdx", "risk_level", "update_policy", "permissions",
];
const SNAPSHOT_LABELS = {
  id: "插件 ID",
  name: "包名",
  version: "版本",
  sha256: "包 SHA-256",
  attachment_url: "附件地址",
  author: "作者署名",
  submitted_by: "投稿者",
  license_label: "许可证",
  license_spdx: "许可证 SPDX",
  risk_level: "风险级别",
  update_policy: "更新策略",
  permissions: "权限",
};
const PUBLISH_STATUSES = new Set(["publishing", "pushed", "released", "indexed"]);

function firstLine(value) {
  return String(value || "").split(/\r?\n/, 1)[0].trim();
}

function parseContentSubmission(body) {
  const packageField = field(body, "插件包 / Package");
  return {
    id: firstLine(field(body, "插件 ID / Plugin ID")),
    attachments: attachmentUrls(packageField),
    author: firstLine(field(body, "作者署名 / Author")),
    license: firstLine(field(body, "许可证 / License")),
    note: field(body, "补充说明 / Additional information").trim(),
  };
}

function attachmentUrls(text) {
  const found = String(text || "").match(ATTACHMENT_RE) || [];
  return [...new Set(found)].filter(url => /\.zip$/i.test(new URL(url).pathname));
}

function singleAttachment(submission) {
  if (submission.attachments.length === 0) {
    throw new Error("「插件包」一栏里没有找到 .zip 附件。请把导出的文件改名为 .zip 后拖进去，等它变成链接再提交");
  }
  if (submission.attachments.length > 1) throw new Error("「插件包」一栏只能放一个 .zip 文件");
  return submission.attachments[0];
}

function hostedRepository(id) {
  if (!PLUGIN_ID_RE.test(String(id || ""))) throw new Error(`插件 ID 格式无效：${id || "<empty>"}`);
  const repo = `${HOSTED_REPO_PREFIX}${id}`;
  return { owner: HOSTING_OWNER, repo, url: `https://github.com/${HOSTING_OWNER}/${repo}` };
}

function licenseChoice(label) {
  if (label === INCLUDED_LICENSE) return { label, included: true, spdx: "" };
  const known = LICENSES[label];
  if (!known) throw new Error(`请选择许可证（收到：${label || "<empty>"}）`);
  return { label, included: false, ...known };
}

function versionParts(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`版本号格式无效：${version}`);
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some(part => !part)) throw new Error(`版本号格式无效：${version}`);
  return { core: match.slice(1, 4).map(Number), prerelease };
}

// SemVer 2.0.0：数字标识符按数值比较，字母标识符按 ASCII 比较，数字标识符优先级更低，
// 标识符数量少时优先级更低；同一核心版本下预发布版本低于正式版。
function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const leftValue = Number(left[index]);
      const rightValue = Number(right[index]);
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

// 只用于判断“更新必须比已收录版本高”；预发布版本低于同号正式版。
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * 判断这次投稿是新包还是已托管包的更新。
 * 已托管包只接受原投稿者或维护者的更新；ID 被普通仓库插件占用时拒绝。
 */
function submissionMode(entries, id, submitter, isMaintainer) {
  const entry = entries.find(item => item.id === id);
  if (!entry) return { mode: "new", entry: null };
  if (!entry.hosted) throw new Error(`插件 ID 已被 ${entry.repository_url} 使用，请换一个 ID`);
  if (entry.submitted_by !== submitter && !isMaintainer) {
    throw new Error(`这个包由 @${entry.submitted_by} 投稿，只有原投稿者或维护者可以提交更新`);
  }
  return { mode: "update", entry };
}

function checkPackageReport(report, { id, license }) {
  const errors = Array.isArray(report && report.errors) ? report.errors : [];
  if (!report || !report.ok) {
    throw new Error(`内容包校验失败：\n\n${errors.map(item => `- ${item}`).join("\n") || "- 未知错误"}`);
  }
  const pkg = report.package || {};
  if (pkg.plugin_id !== id) throw new Error(`投稿 ID (${id}) 与包里 plugin.json.id (${pkg.plugin_id}) 不一致`);
  if (pkg.plugin_type !== "content-pack") throw new Error(`这个表单只收内容包，收到的类型是 ${pkg.plugin_type || "<empty>"}`);
  if (!pkg.has_readme) throw new Error("包里需要 README_CN.md、README.md，或 plugin.json.docs 指向的说明文件");
  if (license.included && !pkg.has_license) throw new Error("选择了「包里已有 LICENSE」，但包里没有 LICENSE、LICENSE.md 或 LICENSE.txt");
  return pkg;
}

function licenseFileText({ license, author, name, year }) {
  if (license.included) return null;
  const text = fs.readFileSync(path.join(LICENSES_DIR, `${license.spdx}.txt`), "utf8").replace(/\r\n/g, "\n");
  if (license.spdx === "MIT") {
    return text.replace("<year>", String(year)).replace("<copyright holders>", author);
  }
  const holder = license.spdx === "CC0-1.0"
    ? `${name}\nDedicated to the public domain by ${author} (${year})`
    : `${name}\nCopyright (c) ${year} ${author}`;
  const header = `${holder}\n\nLicensed under ${license.label} (${license.spdx}): ${license.url}\nThe full license text follows.\n\n`;
  return header + text;
}

// ---------------------------------------------------------------------------
// 发布内容扫描与安全复制（SEC-1）
// ---------------------------------------------------------------------------

function normalizeEntryName(name) {
  return String(name || "").toLowerCase().replace(/[. ]+$/, "");
}

function isProtectedName(name) {
  return PROTECTED_NAMES.has(normalizeEntryName(name));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * 遍历待发布目录，返回只含普通文件的清单，并在任何 Git 操作之前拒绝：
 * Git 元数据 / 属性 / 忽略规则 / CI 配置、符号链接、特殊文件、大小写冲突路径。
 */
function scanContentTree(root, options = {}) {
  const fsImpl = options.fs || fs;
  const skipGitDir = options.skipGitDir === true;
  const maxFiles = options.maxFiles || MAX_PUBLISH_FILES;
  const maxBytes = options.maxBytes || MAX_PUBLISH_BYTES;
  const rootPath = path.resolve(root);
  const files = [];
  const seen = new Map();
  let bytes = 0;
  const walk = (dir, prefix) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const name = String(entry.name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (skipGitDir && !prefix && name === ".git") continue;
      if (isProtectedName(name)) {
        throw new Error(`内容包包含不允许发布的 Git 元数据或 CI 配置：${relative}。请删除后重新导出`);
      }
      const absolute = path.join(dir, name);
      const info = fsImpl.lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`内容包包含符号链接：${relative}`);
      if (info.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!info.isFile()) throw new Error(`内容包包含非普通文件：${relative}`);
      const lower = relative.toLowerCase();
      const clash = seen.get(lower);
      if (clash) throw new Error(`内容包包含大小写不同的同名文件：${clash} 与 ${relative}`);
      seen.set(lower, relative);
      files.push({ path: relative, size: info.size, sha256: sha256File(absolute) });
      bytes += info.size;
      if (files.length > maxFiles) throw new Error(`内容包文件数量超过 ${maxFiles} 个`);
      if (bytes > maxBytes) throw new Error(`内容包解压后超过 ${maxBytes} 字节`);
    }
  };
  walk(rootPath, "");
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, bytes };
}

/**
 * 按扫描清单逐个复制普通文件；不递归复制目录，因此不会把 .git 之类的东西带过去。
 * 复制后再次校验类型与 SHA-256，避免复制过程中被替换。
 */
function copyContentTree(files, sourceRoot, destinationRoot, options = {}) {
  const fsImpl = options.fs || fs;
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  for (const file of files) {
    const parts = String(file.path || "").split("/");
    if (!parts.length || parts.some(part => !part || part === "." || part === "..")) {
      throw new Error(`内容包包含无效路径：${file.path}`);
    }
    if (parts.some(part => isProtectedName(part))) {
      throw new Error(`内容包包含不允许发布的路径：${file.path}`);
    }
    const target = path.join(destination, ...parts);
    const relative = path.relative(destination, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`内容包包含越界路径：${file.path}`);
    }
    const from = path.join(source, ...parts);
    const fromInfo = fsImpl.lstatSync(from);
    if (!fromInfo.isFile() || fromInfo.isSymbolicLink()) throw new Error(`内容包包含非普通文件：${file.path}`);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(from, target, fs.constants.COPYFILE_EXCL);
    const targetInfo = fsImpl.lstatSync(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error(`复制后不是普通文件：${file.path}`);
    if (sha256File(target) !== file.sha256) throw new Error(`复制后内容校验失败：${file.path}`);
  }
}

function contentIndex(entries) {
  const map = new Map();
  for (const entry of entries || []) map.set(String(entry.path), String(entry.sha256));
  return map;
}

function sameContent(left, right) {
  const a = contentIndex(left);
  const b = contentIndex(right);
  if (a.size !== b.size) return false;
  for (const [file, hash] of a) {
    if (b.get(file) !== hash) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 审核快照与发布状态（APPROVE-1 / PUB-2）
// ---------------------------------------------------------------------------

function snapshotOf(marker) {
  const value = marker || {};
  const snapshot = {};
  for (const key of SNAPSHOT_FIELDS) {
    if (key === "permissions") {
      snapshot.permissions = Array.isArray(value.permissions) ? [...new Set(value.permissions.map(String))].sort() : null;
      continue;
    }
    snapshot[key] = value[key] === undefined ? null : String(value[key]);
  }
  return snapshot;
}

function diffSnapshots(checked, current) {
  const left = snapshotOf(checked);
  const right = snapshotOf(current);
  return SNAPSHOT_FIELDS.filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function isSha256(value) {
  return SHA256_RE.test(String(value || ""));
}

function validateMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (marker.snapshot_version !== 1) return false;
  if (!PLUGIN_ID_RE.test(String(marker.id || ""))) return false;
  if (!SEMVER_RE.test(String(marker.version || ""))) return false;
  if (!isSha256(marker.sha256)) return false;
  if (typeof marker.attachment_url !== "string" || !marker.attachment_url.startsWith("https://github.com/")) return false;
  if (typeof marker.name !== "string" || !marker.name) return false;
  if (typeof marker.author !== "string" || !marker.author) return false;
  if (typeof marker.submitted_by !== "string" || !marker.submitted_by) return false;
  if (typeof marker.license_label !== "string") return false;
  if (typeof marker.license_spdx !== "string") return false;
  if (!Array.isArray(marker.permissions) || marker.permissions.some(item => typeof item !== "string")) return false;
  return true;
}

function encodeMarker(value) {
  return Buffer.from(JSON.stringify({ snapshot_version: 1, ...value })).toString("base64url");
}

function decodeMarker(body) {
  const match = String(body || "").match(/<!-- diceframe-content-validation:([A-Za-z0-9_-]{1,12000}) -->/);
  if (!match) return null;
  let value;
  try {
    value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return validateMarker(value) ? value : null;
}

const VALIDATION_FAILED_MARKER = "<!-- diceframe-content-validation-failed -->";

function validatePublishState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  if (!PLUGIN_ID_RE.test(String(state.id || ""))) return false;
  if (!SEMVER_RE.test(String(state.version || ""))) return false;
  if (!isSha256(state.sha256)) return false;
  if (!PUBLISH_STATUSES.has(String(state.status || ""))) return false;
  if (typeof state.repository !== "string" || !state.repository) return false;
  return true;
}

function encodePublishState(state) {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodePublishState(body) {
  const match = String(body || "").match(/<!-- diceframe-content-publish:([A-Za-z0-9_-]{1,12000}) -->/);
  if (!match) return null;
  let value;
  try {
    value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return validatePublishState(value) ? value : null;
}

// ---------------------------------------------------------------------------
// 索引条目与发布结果校验
// ---------------------------------------------------------------------------

function assertHostedEntryIdentity(entry, id) {
  if (!entry || entry.hosted !== true) throw new Error(`插件 ${id} 不是托管内容包，不能按托管流程更新`);
  const expected = hostedRepository(id).url.toLowerCase();
  const actual = normalizeRepositoryUrl(entry.repository_url).url.toLowerCase();
  if (actual !== expected) throw new Error(`插件 ${id} 的托管仓库地址不是 ${hostedRepository(id).url}，请维护者手动处理`);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(entry.approved_release_tag || ""))) {
    throw new Error(`插件 ${id} 缺少已批准的 Release 记录，请维护者手动处理`);
  }
  if (!/^[0-9a-f]{40}$/i.test(String(entry.approved_commit || ""))) {
    throw new Error(`插件 ${id} 缺少已批准的提交记录，请维护者手动处理`);
  }
  return entry;
}

/** 批准流程在宣布成功前必须确认生成的详情可安装，且版本 / Release / 提交都属于这次投稿。 */
function verifyPublishedDetail(detail, marker, release) {
  if (!detail) throw new Error(`生成插件详情时缺少 ${marker.id}`);
  if (detail.installable !== true) {
    throw new Error(`生成的详情不可安装：${detail.verification_error || "未提供原因"}`);
  }
  const latest = detail.latest || {};
  if (String(latest.version || "") !== String(marker.version)) {
    throw new Error(`生成的详情版本 ${latest.version || "<empty>"} 与投稿版本 ${marker.version} 不一致`);
  }
  if (String(latest.release_tag || "") !== String(release.tag)) {
    throw new Error(`生成的详情 Release ${latest.release_tag || "<empty>"} 与 ${release.tag} 不一致`);
  }
  if (String(latest.commit_sha || "").toLowerCase() !== String(release.commitSha || "").toLowerCase()) {
    throw new Error("生成的详情提交与本次发布的提交不一致");
  }
  if (marker.author && detail.author !== marker.author) {
    throw new Error(`生成的详情作者是 ${detail.author || "<empty>"}，与审核过的署名人 ${marker.author} 不一致`);
  }
  if (marker.license_spdx && detail.license !== marker.license_spdx) {
    throw new Error(`生成的详情许可证是 ${detail.license || "<empty>"}，与审核过的 ${marker.license_spdx} 不一致`);
  }
  return true;
}

function hostedEntry(marker, release, approval) {
  return {
    id: marker.id,
    repository_url: hostedRepository(marker.id).url,
    branch: "main",
    approved_release_tag: release.tag,
    approved_commit: release.commitSha,
    risk_level: marker.risk_level,
    update_policy: marker.update_policy,
    approved_permissions: marker.permissions,
    trust_level: "community",
    hosted: true,
    author: marker.author,
    submitted_by: marker.submitted_by,
    // 包里自带 LICENSE 时不记录，客户端退回读取 manifest.license。
    ...(marker.license_spdx ? { license: marker.license_spdx } : {}),
    approved_by: approval.by,
    approved_at: approval.at,
  };
}

function updatedHostedEntry(entry, marker, release, approval) {
  const { license: _previous, ...rest } = entry;
  return {
    ...rest,
    approved_release_tag: release.tag,
    approved_commit: release.commitSha,
    risk_level: marker.risk_level,
    update_policy: marker.update_policy,
    approved_permissions: marker.permissions,
    author: marker.author,
    ...(marker.license_spdx ? { license: marker.license_spdx } : {}),
    approved_by: approval.by,
    approved_at: approval.at,
  };
}

module.exports = {
  CONTENT_TITLE_RE,
  HOSTING_OWNER,
  INCLUDED_LICENSE,
  LICENSES,
  MAX_PACKAGE_BYTES,
  MAX_PUBLISH_BYTES,
  MAX_PUBLISH_FILES,
  PROTECTED_NAMES,
  SNAPSHOT_FIELDS,
  SNAPSHOT_LABELS,
  VALIDATION_FAILED_MARKER,
  assertHostedEntryIdentity,
  attachmentUrls,
  checkPackageReport,
  compareVersions,
  contentIndex,
  copyContentTree,
  decodeMarker,
  decodePublishState,
  diffSnapshots,
  encodeMarker,
  encodePublishState,
  hostedEntry,
  hostedRepository,
  isProtectedName,
  isSha256,
  licenseChoice,
  licenseFileText,
  parseContentSubmission,
  sameContent,
  scanContentTree,
  singleAttachment,
  snapshotOf,
  submissionMode,
  updatedHostedEntry,
  validateMarker,
  validatePublishState,
  verifyPublishedDetail,
};
