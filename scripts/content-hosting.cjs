"use strict";

// 内容包投稿托管（没有自己仓库的作者上传 .zip，由 DiceFrame 组织代建仓库发布）。
// 这里只放纯函数，便于测试；读写 GitHub 的流程在 content-submission.cjs。

const fs = require("fs");
const path = require("path");
const { PLUGIN_ID_RE, field } = require("./registry.cjs");

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
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] || "" };
}

// 只用于判断“更新必须比已收录版本高”；预发布版本低于同号正式版。
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
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
  if (license.included && !pkg.has_license) throw new Error("选择了「包里已有 LICENSE」，但包里没有 LICENSE 或 LICENSE.md");
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

function encodeMarker(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeMarker(body) {
  const match = String(body || "").match(/<!-- diceframe-content-validation:([A-Za-z0-9_-]+) -->/);
  return match ? JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) : null;
}

module.exports = {
  CONTENT_TITLE_RE,
  HOSTING_OWNER,
  INCLUDED_LICENSE,
  LICENSES,
  MAX_PACKAGE_BYTES,
  attachmentUrls,
  checkPackageReport,
  compareVersions,
  decodeMarker,
  encodeMarker,
  hostedEntry,
  hostedRepository,
  licenseChoice,
  licenseFileText,
  parseContentSubmission,
  singleAttachment,
  submissionMode,
  updatedHostedEntry,
};
