"use strict";

const fs = require("fs");
const path = require("path");

const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// 与 DiceFrame 主仓库 scripts/validate_content_module.py 接受的文件名保持一致。
const LICENSE_FILE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt"];
const PLUGIN_TYPES = new Set([
  "channel-adapter", "bot-extension", "content-pack", "theme", "voice-pack",
  "import-export", "provider", "tool",
]);
const DECLARATIVE_TYPES = new Set(["content-pack", "theme", "voice-pack"]);
const INSTALLABLE_TYPES = new Set(["channel-adapter", "bot-extension", "content-pack", "theme", "voice-pack", "tool"]);
const ALLOWED_PERMISSIONS = new Set([
  "process.spawn", "network.client", "diceframe.http", "plugin.config",
  "plugin.secrets", "plugin.data", "content.read", "content.import",
  "theme.tokens", "map.assets", "voice.assets", "tool.execute", "bot.extend", "tunnel.publish",
]);
const MAP_CONTRIBUTION_FIELDS = new Set([
  "map_definitions", "map_locations", "map_icons", "map_backgrounds",
]);

function field(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(body || "").match(new RegExp(`###\\s+${escaped}\\s*\\r?\\n+([\\s\\S]*?)(?=\\r?\\n###\\s|$)`, "i"));
  if (!match) return "";
  const value = match[1].trim();
  return value === "_No response_" ? "" : value;
}

function parseSubmission(body) {
  return {
    id: field(body, "插件 ID / Plugin ID").split(/\r?\n/, 1)[0].trim(),
    repositoryUrl: field(body, "仓库地址 / Repository URL").split(/\r?\n/, 1)[0].trim(),
    note: field(body, "补充说明 / Additional information").trim(),
  };
}

function normalizeRepositoryUrl(value) {
  const raw = String(value || "").trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = raw.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("仓库地址必须是 https://github.com/owner/repo 格式的公开 GitHub 仓库");
  return { url: `https://github.com/${match[1]}/${match[2]}`, owner: match[1], repo: match[2] };
}

function cleanStringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} 必须是非空字符串数组`);
  }
  return [...new Set(value.map(item => item.trim()))].sort();
}

function classifyManifest(manifest) {
  const hasEntrypoint = Array.isArray(manifest.entrypoint) && manifest.entrypoint.length > 0;
  if (hasEntrypoint) {
    return {
      riskLevel: "unrestricted-process",
      updatePolicy: "notify",
      summary: "包含可执行进程；以当前操作系统用户权限运行，更新只提醒，不静默安装",
    };
  }
  if (DECLARATIVE_TYPES.has(manifest.plugin_type)) {
    return {
      riskLevel: "declarative",
      updatePolicy: "automatic",
      summary: "仅声明数据与资源；权限不扩大时自动检查并提示，由用户确认后更新",
    };
  }
  return {
    riskLevel: "unsupported-runtime",
    updatePolicy: "blocked",
    summary: "当前 DiceFrame 尚未提供此类型所需的安全运行时",
  };
}

function validateManifest(manifest, expectedId, repositoryUrl) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("plugin.json 必须是 JSON 对象");
  for (const key of ["schema_version", "id", "name", "version", "description", "plugin_type"]) {
    if (manifest[key] === undefined || manifest[key] === "") throw new Error(`plugin.json 缺少 ${key}`);
  }
  if (manifest.schema_version !== 1) throw new Error("plugin.json.schema_version 必须为 1");
  if (!PLUGIN_ID_RE.test(String(manifest.id))) throw new Error("plugin.json.id 格式无效");
  if (manifest.id !== expectedId) throw new Error(`投稿 ID (${expectedId}) 与 plugin.json.id (${manifest.id}) 不一致`);
  if (!SEMVER_RE.test(String(manifest.version))) throw new Error("plugin.json.version 必须使用三段式版本号，例如 1.0.0");
  if (!PLUGIN_TYPES.has(String(manifest.plugin_type))) throw new Error(`不支持的 plugin_type：${manifest.plugin_type}`);
  if (!INSTALLABLE_TYPES.has(String(manifest.plugin_type))) throw new Error(`plugin_type ${manifest.plugin_type} 仍是预留能力，暂不收录`);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error("plugin.json.name 不能为空");
  if (typeof manifest.description !== "string" || !manifest.description.trim()) throw new Error("plugin.json.description 不能为空");
  const capabilities = cleanStringArray(manifest.capabilities, "capabilities");
  const permissions = cleanStringArray(manifest.permissions, "permissions");
  const unknown = permissions.filter(item => !ALLOWED_PERMISSIONS.has(item));
  if (unknown.length) throw new Error(`plugin.json 包含未知权限：${unknown.join(", ")}`);
  const risk = classifyManifest(manifest);
  if (risk.updatePolicy === "blocked") throw new Error(risk.summary);
  const repository = String(manifest.repository_url || manifest.repositoryUrl || "").replace(/\/$/, "").replace(/\.git$/, "");
  if (repository && repository.toLowerCase() !== repositoryUrl.toLowerCase()) {
    throw new Error("plugin.json 中声明的仓库地址与投稿地址不一致");
  }
  return { ...risk, capabilities, permissions };
}

function addedPermissions(approved, current) {
  const baseline = new Set(Array.isArray(approved) ? approved : []);
  return (Array.isArray(current) ? current : []).filter(item => !baseline.has(item));
}

function effectivePermissions(manifest, schema = {}) {
  const declared = Array.isArray(manifest.permissions) ? manifest.permissions.filter(item => String(item || "").trim()) : [];
  if (declared.length) return [...new Set(declared.map(item => String(item).trim()))].sort();
  const inferred = new Set(["plugin.config"]);
  const properties = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
    ? Object.values(schema.properties)
    : [];
  if (properties.some(field => field && typeof field === "object" && (field.ui?.sensitive || field.ui?.control === "secret"))) {
    inferred.add("plugin.secrets");
  }
  if (Array.isArray(manifest.entrypoint) && manifest.entrypoint.length) {
    inferred.add("process.spawn");
    inferred.add("plugin.data");
  }
  if (manifest.plugin_type === "channel-adapter") {
    inferred.add("network.client");
    inferred.add("diceframe.http");
  } else if (manifest.plugin_type === "content-pack") {
    inferred.add("content.read");
    inferred.add("content.import");
    const contributes = manifest.contributes && typeof manifest.contributes === "object"
      ? manifest.contributes
      : {};
    if (Object.keys(contributes).some(key => MAP_CONTRIBUTION_FIELDS.has(key))) inferred.add("map.assets");
  } else if (manifest.plugin_type === "theme") {
    inferred.add("theme.tokens");
  } else if (manifest.plugin_type === "voice-pack") {
    inferred.add("voice.assets");
  } else if (manifest.plugin_type === "tool") {
    inferred.add("tool.execute");
  } else if (manifest.plugin_type === "bot-extension") {
    inferred.add("bot.extend");
  }
  return [...inferred].sort();
}

async function githubApi(apiPath, options = {}) {
  const token = options.token || process.env.GITHUB_TOKEN || "";
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "diceframe-plugin-registry",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (options.allow404 && response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function getJsonFile(owner, repo, filePath, ref, token) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const data = await githubApi(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, { token });
  if (!data || data.type !== "file" || data.encoding !== "base64") throw new Error(`${filePath} 不是普通文件`);
  try {
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`${filePath} 不是有效 JSON：${error.message}`);
  }
}

async function fileExists(owner, repo, filePath, ref, token) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return Boolean(await githubApi(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, { token, allow404: true }));
}

async function findLicenseFile(owner, repo, ref, token) {
  for (const name of LICENSE_FILE_NAMES) {
    if (await fileExists(owner, repo, name, ref, token)) return name;
  }
  return "";
}

async function loadReleaseSnapshot(repositoryUrl, expectedId, token) {
  const parsed = normalizeRepositoryUrl(repositoryUrl);
  const repoInfo = await githubApi(`/repos/${parsed.owner}/${parsed.repo}`, { token });
  if (repoInfo.private) throw new Error("插件仓库必须公开");
  if (repoInfo.archived || repoInfo.disabled) throw new Error("插件仓库已归档或禁用");
  const release = await githubApi(`/repos/${parsed.owner}/${parsed.repo}/releases/latest`, { token, allow404: true });
  if (!release || release.draft || release.prerelease) throw new Error("仓库必须先发布一个非草稿、非预发布的 GitHub Release");
  const commit = await githubApi(`/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(release.tag_name)}`, { token });
  const manifest = await getJsonFile(parsed.owner, parsed.repo, "plugin.json", commit.sha, token);
  const policy = validateManifest(manifest, expectedId, parsed.url);

  const tree = await githubApi(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${commit.sha}?recursive=1`, { token });
  const files = Array.isArray(tree.tree) ? tree.tree.filter(item => item.type === "blob") : [];
  if (tree.truncated) throw new Error("插件仓库文件树过大，无法完整审核");
  if (files.length > 2048) throw new Error("插件文件数量超过 2048 个");
  const totalBytes = files.reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (totalBytes > 100 * 1024 * 1024) throw new Error("插件仓库文件总大小超过 100 MB");
  const suspicious = files.map(item => String(item.path || "")).filter(name =>
    /(^|\/)(\.env(?:\.|$)|id_rsa|id_ed25519|secrets?\.json|credentials?\.json)$/i.test(name) ||
    /\.(pem|p12|pfx|key)$/i.test(name)
  );
  if (suspicious.length) throw new Error(`仓库包含疑似秘密文件：${suspicious.slice(0, 5).join(", ")}`);

  const configPath = String(manifest.config_schema || "config.schema.json").trim();
  let schema;
  try {
    schema = await getJsonFile(parsed.owner, parsed.repo, configPath, commit.sha, token);
  } catch (error) {
    throw new Error(`plugin.json 指向的配置文件无效：${configPath}；${error.message}`);
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("配置 Schema 必须是 JSON 对象");
  policy.permissions = effectivePermissions(manifest, schema);
  const docsPath = String(manifest.docs || "").trim();
  const hasDocs = docsPath
    ? await fileExists(parsed.owner, parsed.repo, docsPath, commit.sha, token)
    : (await fileExists(parsed.owner, parsed.repo, "README_CN.md", commit.sha, token)) ||
      (await fileExists(parsed.owner, parsed.repo, "README.md", commit.sha, token));
  if (!hasDocs) throw new Error("仓库根目录需要 README_CN.md、README.md，或 plugin.json.docs 指向的说明文件");
  const hasLicense = await findLicenseFile(parsed.owner, parsed.repo, commit.sha, token);
  if (!hasLicense) throw new Error("仓库根目录需要 LICENSE、LICENSE.md 或 LICENSE.txt");

  return {
    id: expectedId,
    repositoryUrl: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: repoInfo.default_branch,
    stars: Number(repoInfo.stargazers_count) || 0,
    releaseTag: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at || "",
    commitSha: commit.sha,
    manifest,
    ...policy,
  };
}

function detailFromSnapshot(entry, snapshot) {
  const added = addedPermissions(entry.approved_permissions, snapshot.permissions);
  const riskChanged = entry.risk_level && entry.risk_level !== snapshot.riskLevel;
  const approvalRequired = added.length > 0 || riskChanged;
  return {
    id: entry.id,
    repository_url: entry.repository_url,
    branch: snapshot.branch,
    // DiceFrame 代为托管的包仓库属于 diceframe 组织，作者以投稿时的署名为准。
    author: entry.author || snapshot.owner,
    ...(entry.license ? { license: entry.license } : {}),
    stars: snapshot.stars,
    release_tag: snapshot.releaseTag,
    release_url: snapshot.releaseUrl,
    commit_sha: snapshot.commitSha,
    latest: {
      version: String(snapshot.manifest.version || ""),
      release_tag: snapshot.releaseTag,
      release_url: snapshot.releaseUrl,
      commit_sha: snapshot.commitSha,
      published_at: snapshot.publishedAt || "",
      requires_approval: approvalRequired,
    },
    archive_url: `https://github.com/${snapshot.owner}/${snapshot.repo}/archive/${snapshot.commitSha}.zip`,
    distribution: "repository",
    risk_level: snapshot.riskLevel,
    update_policy: approvalRequired ? "approval-required" : snapshot.updatePolicy,
    approved_permissions: entry.approved_permissions || [],
    permission_changes: added,
    trust_level: entry.trust_level || "community",
    installable: !approvalRequired,
    verification_error: approvalRequired ? "新版本扩大了权限或改变了运行方式，需要重新审核" : "",
    manifest: snapshot.manifest,
  };
}

async function generateDetails(entries, token) {
  const details = [];
  const warnings = [];
  for (const entry of entries) {
    if (entry.distribution === "bundled") {
      details.push({
        id: entry.id,
        repository_url: entry.repository_url,
        branch: entry.branch || "main",
        plugin_path: entry.plugin_path || "",
        distribution: "bundled",
        risk_level: "bundled",
        update_policy: "application",
        trust_level: "official",
        installable: false,
        verification_error: "此插件随 DiceFrame 提供并跟随主程序更新",
        stars: 0,
        manifest: entry.manifest || {},
      });
      continue;
    }
    try {
      const snapshot = await loadReleaseSnapshot(entry.repository_url, entry.id, token);
      details.push(detailFromSnapshot(entry, snapshot));
    } catch (error) {
      warnings.push(`${entry.id}: ${error.message}`);
      details.push({
        id: entry.id,
        repository_url: entry.repository_url,
        distribution: "repository",
        risk_level: entry.risk_level || "unknown",
        update_policy: "blocked",
        trust_level: entry.trust_level || "community",
        installable: false,
        verification_error: `同步失败：${error.message}`,
        stars: 0,
        manifest: {},
      });
    }
  }
  return { details, warnings };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateHostedEntry(entry, id) {
  if (entry.hosted !== true) throw new Error(`${id}.hosted 只能是 true`);
  const expected = `https://github.com/diceframe/module-${id}`;
  if (normalizeRepositoryUrl(entry.repository_url).url !== expected) {
    throw new Error(`${id} 是托管内容包，仓库地址必须是 ${expected}`);
  }
  for (const key of ["author", "submitted_by"]) {
    if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`${id}.${key} 不能为空`);
  }
  if (entry.license !== undefined && typeof entry.license !== "string") throw new Error(`${id}.license 必须是字符串`);
  if (entry.trust_level !== "community") throw new Error(`${id} 是托管内容包，trust_level 必须是 community`);
}

function validateRegistry(entries, details) {
  if (!Array.isArray(entries) || !Array.isArray(details)) throw new Error("plugins.json 和 plugin_details.json 必须是数组");
  const ids = new Set();
  const repositories = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("plugins.json 条目必须是对象");
    const id = String(entry.id || "");
    if (!PLUGIN_ID_RE.test(id)) throw new Error(`无效插件 ID：${id || "<empty>"}`);
    if (ids.has(id)) throw new Error(`重复插件 ID：${id}`);
    ids.add(id);
    const repository = normalizeRepositoryUrl(entry.repository_url).url.toLowerCase();
    if (repositories.has(repository) && entry.distribution !== "bundled") throw new Error(`重复插件仓库：${entry.repository_url}`);
    repositories.add(repository);
    cleanStringArray(entry.approved_permissions, `${id}.approved_permissions`).forEach(permission => {
      if (!ALLOWED_PERMISSIONS.has(permission)) throw new Error(`${id} 包含未知已批准权限：${permission}`);
    });
    const distribution = String(entry.distribution || "repository");
    if (!["repository", "bundled"].includes(distribution)) throw new Error(`${id} 的 distribution 无效`);
    if (distribution === "repository" && !["automatic", "notify"].includes(entry.update_policy)) {
      throw new Error(`${id} 的社区更新策略必须是 automatic 或 notify`);
    }
    if (entry.hosted !== undefined) validateHostedEntry(entry, id);
  }
  const detailIds = details.map(item => String(item && item.id || ""));
  if (new Set(detailIds).size !== detailIds.length) throw new Error("plugin_details.json 包含重复 ID");
  const missing = [...ids].filter(id => !detailIds.includes(id));
  const extra = detailIds.filter(id => !ids.has(id));
  if (missing.length || extra.length) throw new Error(`索引与详情 ID 不一致；缺少：${missing.join(", ") || "无"}；多余：${extra.join(", ") || "无"}`);
  return true;
}

module.exports = {
  ALLOWED_PERMISSIONS,
  LICENSE_FILE_NAMES,
  PLUGIN_ID_RE,
  SEMVER_RE,
  addedPermissions,
  classifyManifest,
  detailFromSnapshot,
  effectivePermissions,
  field,
  findLicenseFile,
  generateDetails,
  githubApi,
  loadReleaseSnapshot,
  normalizeRepositoryUrl,
  parseSubmission,
  readJson,
  validateManifest,
  validateRegistry,
  writeJson,
};
