"use strict";

// 隔离集成测试：用 mock GitHub API 与内存版托管仓库跑「校验 → 批准 → 发布 → 索引 → 收尾」，
// 不接触真实组织仓库，也不依赖 CONTENT_HOSTING_TOKEN。真实 Git 的路径在最后单独覆盖。

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const hosting = require("../scripts/content-hosting.cjs");
const {
  createBot,
  createGitWorkspace,
  redactSecret,
  safeText,
} = require("../scripts/content-submission.cjs");

const OWNER = "diceframe";
const REPO = "diceframe-plugins";
const ISSUE_NUMBER = 15;
const SUBMITTER = "kobayashi";
const MAINTAINER = "maintainer";
const BOT_LOGIN = "github-actions[bot]";
const ATTACHMENT = "https://github.com/user-attachments/files/19876543/my-adventure-1.0.0.zip";
const ISSUE_URL = `https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function issueBody(options = {}) {
  const id = options.id || "my-adventure";
  const attachment = options.attachment || ATTACHMENT;
  const author = options.author || "";
  const license = options.license || "CC BY 4.0";
  return [
    "### 插件 ID / Plugin ID",
    "",
    id,
    "",
    "### 插件包 / Package",
    "",
    `[package.zip](${attachment})`,
    "",
    "### 作者署名 / Author",
    "",
    author || "_No response_",
    "",
    "### 许可证 / License",
    "",
    license,
    "",
    "### 投稿确认 / Confirmation",
    "",
    "- [X] 内容是我原创的，或者我已获得改编和分发的授权",
    "",
    "### 补充说明 / Additional information",
    "",
    "_No response_",
  ].join("\n");
}

function packageFactory(options = {}) {
  const id = options.id || "my-adventure";
  const version = options.version || "1.0.0";
  const name = options.name || "My Adventure";
  const licenseFile = options.licenseFile || "";
  const readme = options.readme || "# My Adventure\n";
  const extraFiles = options.files || {};
  const report = options.report || {
    ok: true,
    errors: [],
    warnings: [],
    adventures: [{ adventure_id: "plugin:demo" }],
    package: {
      plugin_id: id,
      plugin_type: "content-pack",
      has_readme: true,
      has_license: Boolean(licenseFile),
    },
  };
  return () => {
    const moduleDir = tempDir("module-");
    fs.writeFileSync(path.join(moduleDir, "plugin.json"), JSON.stringify({
      schema_version: 1,
      id,
      name,
      version,
      description: "demo adventure module",
      plugin_type: "content-pack",
    }, null, 2));
    fs.writeFileSync(path.join(moduleDir, "README.md"), readme);
    fs.writeFileSync(path.join(moduleDir, "config.schema.json"), JSON.stringify({ type: "object", properties: {} }));
    if (licenseFile) fs.writeFileSync(path.join(moduleDir, licenseFile), "License text\n");
    for (const [relative, content] of Object.entries(extraFiles)) {
      const absolute = path.join(moduleDir, ...relative.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
    return { report, moduleDir };
  };
}

function createHostedRepos() {
  const repos = new Map();
  const ops = [];
  const replacements = [];
  let failNextPush = false;
  let failNextRelease = false;

  function seed(name, options = {}) {
    const history = options.history ? [...options.history] : (options.head ? [options.head] : []);
    const repo = {
      name,
      info: {
        full_name: `diceframe/${name}`,
        homepage: options.homepage || "",
        description: "DiceFrame 内容包",
        private: false,
        archived: false,
        disabled: false,
        fork: false,
        default_branch: "main",
        ...(options.info || {}),
      },
      branch: options.branch || "main",
      head: options.head || null,
      files: options.files || [],
      history,
      commits: new Set(history),
      releases: new Map(Object.entries(options.releases || {})),
    };
    repos.set(name, repo);
    return repo;
  }

  function createRepo(name, info) {
    const repo = seed(name);
    repo.info = { ...repo.info, ...info };
    return repo;
  }

  async function handle(name, sub, method, opts) {
    const repo = repos.get(name);
    if (!repo) return null;
    if (method === "GET" && !sub) return repo.info;
    if (method === "GET" && sub === "/releases?per_page=1") return [...repo.releases.values()];
    const tagMatch = sub.match(/^\/releases\/tags\/(.+)$/);
    if (method === "GET" && tagMatch) return repo.releases.get(decodeURIComponent(tagMatch[1])) || null;
    if (method === "POST" && sub === "/releases") {
      const tag = opts.body.tag_name;
      if (failNextRelease) {
        failNextRelease = false;
        throw new Error("GitHub API 500: release creation failed");
      }
      if (repo.releases.has(tag)) throw new Error("GitHub API 422: tag already exists");
      const release = {
        tag_name: tag,
        target_commitish: opts.body.target_commitish,
        html_url: `https://github.com/diceframe/${name}/releases/tag/${tag}`,
      };
      repo.releases.set(tag, release);
      return release;
    }
    if (method === "GET" && /^\/git\/ref\/tags\//.test(sub)) return null;
    const commitMatch = sub.match(/^\/commits\/(.+)$/);
    if (method === "GET" && commitMatch) {
      const ref = decodeURIComponent(commitMatch[1]);
      const release = repo.releases.get(ref);
      if (release) return { sha: release.target_commitish };
      if (repo.head === ref) return { sha: repo.head };
      throw new Error("GitHub API 404: Not Found");
    }
    return null;
  }

  async function openWorkspace(url) {
    const name = String(url || "").split("/").pop();
    const repo = repos.get(name);
    if (!repo) throw new Error(`托管仓库不存在：${name}`);
    ops.push({ op: "open", name });
    let workFiles = repo.files;
    const remoteSnapshot = {
      head: repo.head,
      files: repo.files,
      history: [...repo.history],
      commits: new Set(repo.commits),
      releases: new Map(repo.releases),
    };
    return {
      get head() {
        return repo.head;
      },
      get branch() {
        return repo.branch;
      },
      files() {
        return repo.files;
      },
      setMainBranch() {
        repo.branch = "main";
      },
      hasCommit(sha) {
        return repo.commits.has(String(sha).toLowerCase());
      },
      isAncestor(ancestor, descendant) {
        const left = repo.history.indexOf(String(ancestor).toLowerCase());
        const right = repo.history.indexOf(String(descendant).toLowerCase());
        return left >= 0 && right >= 0 && left <= right;
      },
      replaceContents(moduleDir, files) {
        ops.push({ op: "replace", name, count: files.length });
        replacements.push({ name, moduleDir, files });
        workFiles = files;
      },
      commitAll({ subject, body }) {
        if (repo.head && hosting.sameContent(workFiles, repo.files)) return repo.head;
        const sha = crypto.createHash("sha256")
          .update(`${subject}\n${body}\n${repo.history.length}\n${JSON.stringify(workFiles)}`)
          .digest("hex")
          .slice(0, 40);
        repo.files = workFiles;
        repo.head = sha;
        repo.history.push(sha);
        repo.commits.add(sha);
        ops.push({ op: "commit", name, sha });
        return sha;
      },
      push() {
        if (failNextPush) {
          // 推送失败时远端没有任何变化：本地克隆被丢弃。
          failNextPush = false;
          repo.head = remoteSnapshot.head;
          repo.files = remoteSnapshot.files;
          repo.history = [...remoteSnapshot.history];
          repo.commits = new Set(remoteSnapshot.commits);
          repo.releases = new Map(remoteSnapshot.releases);
          throw new Error("push rejected by remote");
        }
        ops.push({ op: "push", name, head: repo.head });
      },
      dispose() {
        ops.push({ op: "dispose", name });
      },
    };
  }

  return {
    ops,
    replacements,
    createRepo,
    get: name => repos.get(name),
    handle,
    openWorkspace,
    releaseCount: name => (repos.get(name) ? repos.get(name).releases.size : 0),
    commitCount: name => (repos.get(name) ? repos.get(name).history.length : 0),
    lastRelease(name) {
      const releases = [...repos.get(name).releases.values()];
      return releases[releases.length - 1];
    },
    seed,
    opsOf: kind => ops.filter(item => item.op === kind),
    failPushOnce() {
      failNextPush = true;
    },
    failReleaseOnce() {
      failNextRelease = true;
    },
  };
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTestEnv(options = {}) {
  const tmpRoot = tempDir("content-submission-");
  const root = path.join(tmpRoot, "registry");
  fs.mkdirSync(root);
  const workRoot = path.join(tmpRoot, "work");
  fs.mkdirSync(workRoot);

  const remoteFiles = {
    "plugins.json": JSON.parse(JSON.stringify(options.entries || [])),
    "plugin_details.json": JSON.parse(JSON.stringify(options.details || [])),
  };
  fs.writeFileSync(path.join(root, "plugins.json"), JSON.stringify(remoteFiles["plugins.json"], null, 2));
  fs.writeFileSync(path.join(root, "plugin_details.json"), JSON.stringify(remoteFiles["plugin_details.json"], null, 2));

  const hosted = createHostedRepos();
  for (const [name, seedOptions] of Object.entries(options.repos || {})) hosted.seed(name, seedOptions);

  const state = {
    issue: options.issueState || "open",
    labels: new Set(options.labels || []),
  };
  const submitter = options.submitter || SUBMITTER;
  const maintainer = options.maintainer || MAINTAINER;
  const permissions = { [submitter]: "read", [maintainer]: "admin", ...(options.permissions || {}) };
  const comments = options.comments ? options.comments.map(item => ({ user: {}, ...item })) : [];
  let nextCommentId = 1000;
  const calls = [];
  const payload = { value: Buffer.from("content-pack-payload-v1") };
  const queue = [];

  async function api(apiPath, requestOptions = {}) {
    const method = requestOptions.method || "GET";
    calls.push({ path: apiPath, method, body: requestOptions.body });
    const repoBase = `/repos/${OWNER}/${REPO}`;

    if (method === "GET" && apiPath.startsWith(`${repoBase}/labels/`)) return null;
    if (method === "POST" && apiPath === `${repoBase}/labels`) return {};
    if (method === "DELETE" && apiPath.startsWith(`${repoBase}/issues/${ISSUE_NUMBER}/labels/`)) {
      state.labels.delete(decodeURIComponent(apiPath.split("/").pop()));
      return null;
    }
    if (method === "POST" && apiPath === `${repoBase}/issues/${ISSUE_NUMBER}/labels`) {
      for (const name of requestOptions.body.labels) state.labels.add(name);
      return requestOptions.body.labels.map(name => ({ name }));
    }
    if (method === "GET" && apiPath === `${repoBase}/issues/${ISSUE_NUMBER}`) {
      return {
        number: ISSUE_NUMBER,
        state: state.issue,
        labels: [...state.labels].map(name => ({ name })),
      };
    }
    if (method === "PATCH" && apiPath === `${repoBase}/issues/${ISSUE_NUMBER}`) {
      if (requestOptions.body && requestOptions.body.state) state.issue = requestOptions.body.state;
      return { state: state.issue };
    }
    const permissionMatch = apiPath.match(new RegExp(`^${escapeRe(repoBase)}/collaborators/([^/]+)/permission$`));
    if (method === "GET" && permissionMatch) {
      const login = decodeURIComponent(permissionMatch[1]);
      return { permission: permissions[login] || "none" };
    }
    const commentsMatch = apiPath.match(
      new RegExp(`^${escapeRe(repoBase)}/issues/${ISSUE_NUMBER}/comments(?:\\?per_page=(\\d+)&page=(\\d+))?$`),
    );
    if (commentsMatch) {
      if (method === "GET") {
        const size = Number(commentsMatch[1] || 100);
        const page = Number(commentsMatch[2] || 1);
        return comments.slice((page - 1) * size, page * size);
      }
      if (method === "POST") {
        const created = { id: nextCommentId++, user: { login: BOT_LOGIN }, body: requestOptions.body.body };
        comments.push(created);
        return created;
      }
    }
    const editComment = apiPath.match(new RegExp(`^${escapeRe(repoBase)}/issues/comments/(\\d+)$`));
    if (method === "PATCH" && editComment) {
      const found = comments.find(item => String(item.id) === editComment[1]);
      if (found) found.body = requestOptions.body.body;
      return found || {};
    }
    const contentsMatch = apiPath.match(new RegExp(`^${escapeRe(repoBase)}/contents/([^/?]+)\\?ref=main$`));
    if (method === "GET" && contentsMatch) {
      const name = decodeURIComponent(contentsMatch[1]);
      if (!(name in remoteFiles)) return null;
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(remoteFiles[name], null, 2)).toString("base64"),
      };
    }
    if (method === "POST" && apiPath === `/orgs/${OWNER}/repos`) {
      hosted.createRepo(requestOptions.body.name, {
        homepage: requestOptions.body.homepage,
        description: requestOptions.body.description,
      });
      return hosted.get(requestOptions.body.name).info;
    }
    const hostedInfo = apiPath.match(new RegExp(`^/repos/([^/]+)/(module-[a-z0-9-]+)$`));
    if (hostedInfo) return hosted.handle(hostedInfo[2], "", method, requestOptions);
    const hostedSub = apiPath.match(new RegExp(`^/repos/([^/]+)/(module-[a-z0-9-]+)(/.+)$`));
    if (hostedSub) return hosted.handle(hostedSub[2], hostedSub[3], method, requestOptions);
    throw new Error(`unexpected API call: ${method} ${apiPath}`);
  }

  function nextPackage() {
    return queue.length ? queue.shift() : packageFactory();
  }

  function defaultGenerate(entries) {
    return {
      details: entries.map(entry => {
        const version = String(entry.approved_release_tag || "").replace(/^v/, "");
        return {
          id: entry.id,
          repository_url: entry.repository_url,
          branch: "main",
          author: entry.author,
          ...(entry.license ? { license: entry.license } : {}),
          stars: 0,
          release_tag: entry.approved_release_tag,
          release_url: "",
          commit_sha: entry.approved_commit,
          latest: {
            version,
            release_tag: entry.approved_release_tag,
            release_url: "",
            commit_sha: entry.approved_commit,
            published_at: "",
            requires_approval: false,
          },
          archive_url: `https://github.com/diceframe/${entry.id}/archive/${entry.approved_commit}.zip`,
          distribution: "repository",
          risk_level: entry.risk_level,
          update_policy: entry.update_policy,
          approved_permissions: entry.approved_permissions || [],
          permission_changes: [],
          trust_level: entry.trust_level || "community",
          installable: true,
          verification_error: "",
          manifest: { version },
        };
      }),
      warnings: [],
    };
  }

  const body = { value: options.body || issueBody() };
  const env = {
    api,
    calls,
    comments,
    hosted,
    payload,
    queue,
    root,
    state,
    submitter,
    maintainer,
    workRoot,
    queuePackage(packageOptions) {
      queue.push(packageFactory(packageOptions));
      return env;
    },
    setBody(next) {
      body.value = next;
      return env;
    },
    getBody() {
      return body.value;
    },
    makeBot(botOptions = {}) {
      const event = {
        issue: {
          number: ISSUE_NUMBER,
          title: botOptions.title || "[Content Pack] My Adventure",
          body: body.value,
          user: { login: submitter },
          labels: [],
        },
      };
      if (botOptions.comment) {
        event.comment = {
          user: { login: botOptions.comment.login },
          body: botOptions.comment.body,
        };
      }
      return createBot({
        root,
        workRoot,
        repository: `${OWNER}/${REPO}`,
        event,
        token: "test-token",
        hostingToken: "test-hosting-token",
        api,
        download: botOptions.download || (async () => payload.value),
        extract: async () => nextPackage()(),
        openWorkspace: url => hosted.openWorkspace(url),
        generate: botOptions.generate || defaultGenerate,
        now: () => new Date("2026-11-06T00:00:00.000Z"),
        log: () => {},
      });
    },
    approveBot(botOptions = {}) {
      return env.makeBot({ ...botOptions, comment: { login: MAINTAINER, body: "/approve" } });
    },
    entry(id) {
      return JSON.parse(fs.readFileSync(path.join(root, "plugins.json"), "utf8")).find(item => item.id === id);
    },
    registry() {
      return JSON.parse(fs.readFileSync(path.join(root, "plugins.json"), "utf8"));
    },
    details() {
      return JSON.parse(fs.readFileSync(path.join(root, "plugin_details.json"), "utf8"));
    },
    syncRemote() {
      remoteFiles["plugins.json"] = JSON.parse(fs.readFileSync(path.join(root, "plugins.json"), "utf8"));
      remoteFiles["plugin_details.json"] = JSON.parse(fs.readFileSync(path.join(root, "plugin_details.json"), "utf8"));
    },
    snapshot() {
      return {
        plugins: fs.readFileSync(path.join(root, "plugins.json"), "utf8"),
        details: fs.readFileSync(path.join(root, "plugin_details.json"), "utf8"),
        remotePlugins: JSON.parse(JSON.stringify(remoteFiles["plugins.json"])),
        remoteDetails: JSON.parse(JSON.stringify(remoteFiles["plugin_details.json"])),
      };
    },
    restore(snapshot) {
      fs.writeFileSync(path.join(root, "plugins.json"), snapshot.plugins);
      fs.writeFileSync(path.join(root, "plugin_details.json"), snapshot.details);
      remoteFiles["plugins.json"] = JSON.parse(JSON.stringify(snapshot.remotePlugins));
      remoteFiles["plugin_details.json"] = JSON.parse(JSON.stringify(snapshot.remoteDetails));
    },
    lastComment() {
      return comments[comments.length - 1];
    },
    botComments() {
      return comments.filter(item => item.user && item.user.login === BOT_LOGIN);
    },
    callsTo(fragment) {
      return calls.filter(item => item.path.includes(fragment));
    },
  };
  env.bot = env.makeBot();
  return env;
}

function releaseEntry(overrides = {}) {
  return {
    id: "my-adventure",
    repository_url: "https://github.com/diceframe/module-my-adventure",
    branch: "main",
    approved_release_tag: "v0.9.0",
    approved_commit: "a".repeat(40),
    risk_level: "declarative",
    update_policy: "automatic",
    approved_permissions: ["content.import", "content.read", "plugin.config"],
    trust_level: "community",
    hosted: true,
    author: "kobayashi",
    submitted_by: "kobayashi",
    license: "CC-BY-4.0",
    approved_by: "maintainer",
    approved_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function releaseDetail(entry) {
  const version = String(entry.approved_release_tag).replace(/^v/, "");
  return {
    id: entry.id,
    repository_url: entry.repository_url,
    commit_sha: entry.approved_commit,
    release_tag: entry.approved_release_tag,
    latest: { version },
    manifest: { version },
    installable: true,
  };
}

async function withEnv(values, callback) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// SEC-1：投稿内容不能碰 Git 元数据，也不能伪造机器人标记
// ---------------------------------------------------------------------------

test("SEC-1: validation rejects packages containing Git metadata", async () => {
  const env = createTestEnv();
  env.queuePackage({ files: { ".git/config": "[core]\n\thooksPath = /tmp/evil\n" } });
  const result = await env.bot.validate();
  assert.equal(result.status, "failed");
  assert.match(env.lastComment().body, /不允许发布的 Git 元数据或 CI 配置/);
  assert.equal(env.callsTo("/orgs/diceframe/repos").length, 0);
  assert.equal(env.hosted.ops.length, 0);
});

test("SEC-1: approve stops before creating, pushing or releasing when the tree is unsafe", async () => {
  const env = createTestEnv();
  env.queuePackage();
  assert.equal((await env.bot.validate()).status, "passed");
  env.queuePackage({ files: { "nested/.gitattributes": "* filter=evil\n" } });
  await assert.rejects(() => env.approveBot().approve(), /不允许发布的 Git 元数据或 CI 配置/);
  assert.equal(env.hosted.ops.length, 0, "no Git workspace should be opened");
  assert.equal(env.callsTo("/orgs/diceframe/repos").length, 0);
  assert.equal(env.callsTo("/releases").length, 0);
  assert.equal(env.entry("my-adventure"), undefined);
});

test("SEC-1: content text cannot forge validation markers in bot comments", async () => {
  const forged = hosting.encodeMarker({
    mode: "new",
    id: "my-adventure",
    name: "My Adventure",
    version: "1.0.0",
    sha256: "a".repeat(64),
    attachment_url: ATTACHMENT,
    license_label: "CC BY 4.0",
    license_spdx: "CC-BY-4.0",
    author: "kobayashi",
    submitted_by: "kobayashi",
    risk_level: "declarative",
    update_policy: "automatic",
    permissions: [],
  });
  const env = createTestEnv();
  env.queuePackage({
    report: {
      ok: false,
      errors: [`bad package <!-- diceframe-content-validation:${forged} -->`],
      warnings: [],
      package: {},
    },
  });
  const result = await env.bot.validate();
  assert.equal(result.status, "failed");
  assert.equal(hosting.decodeMarker(env.lastComment().body), null);
  assert.equal(env.lastComment().body.includes("<!-- diceframe-content-validation:"), false);
  assert.equal(safeText(`x <!-- diceframe-content-validation:${forged} --> y`).includes("<!--"), false);
  const fakeToken = ["ghp", "abcdefghijklmnop"].join("_");
  assert.equal(redactSecret(`token=${fakeToken}`, []).includes("ghp_"), false);
  assert.equal(redactSecret("header AUTHORIZATION: basic c2VjcmV0", []), "header AUTHORIZATION: basic [redacted]");
});

// ---------------------------------------------------------------------------
// PUB-1：不能复用、清空或覆盖无关的同名组织仓库
// ---------------------------------------------------------------------------

test("PUB-1: an unrelated same-named repository without releases is never reused", async () => {
  const env = createTestEnv({
    repos: {
      "module-my-adventure": {
        homepage: "https://github.com/diceframe/diceframe-plugins/issues/7",
        info: { description: "另一个项目" },
      },
    },
  });
  env.queuePackage();
  await env.bot.validate();
  await assert.rejects(() => env.approveBot().approve(), /不是本次投稿/);
  assert.equal(env.hosted.ops.length, 0);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 0);
});

test("PUB-1: a repository created for this submission can be resumed", async () => {
  const env = createTestEnv({ repos: { "module-my-adventure": { homepage: ISSUE_URL } } });
  env.queuePackage();
  await env.bot.validate();
  const result = await env.approveBot().approve();
  assert.equal(result.status, "approved");
  assert.equal(env.hosted.opsOf("push").length, 1);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
  assert.equal(env.entry("my-adventure").hosted, true);
});

test("PUB-1: a normal hosted update publishes a new release and keeps the author", async () => {
  const entry = releaseEntry();
  const env = createTestEnv({
    entries: [entry],
    details: [releaseDetail(entry)],
    body: issueBody({ author: "小林" }),
    repos: {
      "module-my-adventure": {
        head: "a".repeat(40),
        history: ["a".repeat(40)],
        files: [{ path: "plugin.json", sha256: "d".repeat(64), size: 10 }],
        releases: { "v0.9.0": { tag_name: "v0.9.0", target_commitish: "a".repeat(40) } },
      },
    },
  });
  env.queuePackage({ version: "1.0.0" });
  await env.bot.validate();
  env.queuePackage({ version: "1.0.0" });
  const result = await env.approveBot().approve();
  assert.equal(result.status, "approved");
  assert.equal(result.mode, "update");
  assert.equal(env.hosted.commitCount("module-my-adventure"), 2);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 2);
  const updated = env.entry("my-adventure");
  assert.equal(updated.approved_release_tag, "v1.0.0");
  assert.equal(updated.approved_commit, env.hosted.get("module-my-adventure").head);
  assert.equal(updated.author, "小林");
  assert.equal(updated.submitted_by, "kobayashi");
});

test("PUB-1: updates refuse a repository whose main branch moved unexpectedly", async () => {
  const entry = releaseEntry();
  const env = createTestEnv({
    entries: [entry],
    details: [releaseDetail(entry)],
    repos: {
      "module-my-adventure": {
        homepage: "https://github.com/diceframe/diceframe-plugins/issues/3",
        head: "c".repeat(40),
        history: ["a".repeat(40), "c".repeat(40)],
        files: [{ path: "plugin.json", sha256: "d".repeat(64), size: 10 }],
        releases: { "v0.9.0": { tag_name: "v0.9.0", target_commitish: "a".repeat(40) } },
      },
    },
  });
  env.queuePackage();
  await env.bot.validate();
  await assert.rejects(() => env.approveBot().approve(), /未预期的提交/);
  assert.equal(env.hosted.opsOf("push").length, 0);
  assert.equal(env.hosted.opsOf("commit").length, 0);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
});

test("PUB-1: updates abort when the approved release no longer matches the index", async () => {
  const entry = releaseEntry();
  const env = createTestEnv({
    entries: [entry],
    details: [releaseDetail(entry)],
    repos: {
      "module-my-adventure": {
        head: "a".repeat(40),
        history: ["a".repeat(40)],
        releases: { "v0.9.0": { tag_name: "v0.9.0", target_commitish: "b".repeat(40) } },
      },
    },
  });
  env.queuePackage();
  await env.bot.validate();
  await assert.rejects(() => env.approveBot().approve(), /指向的提交与索引记录不一致/);
  assert.equal(env.hosted.ops.length, 0);
});

test("PUB-1: updates abort when the repository is missing the approved release", async () => {
  const entry = releaseEntry();
  const env = createTestEnv({
    entries: [entry],
    details: [releaseDetail(entry)],
    repos: { "module-my-adventure": { head: "a".repeat(40), history: ["a".repeat(40)] } },
  });
  env.queuePackage();
  await env.bot.validate();
  await assert.rejects(() => env.approveBot().approve(), /缺少已批准的 Release/);
});

// ---------------------------------------------------------------------------
// PUB-2：批准可安全重试，不重复发布、不卡死
// ---------------------------------------------------------------------------

test("PUB-2: re-approving after the index push failed converges without duplicate releases", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  const before = env.snapshot();
  const first = await env.approveBot().approve();
  assert.equal(first.status, "approved");
  const sha = env.hosted.get("module-my-adventure").head;
  const commits = env.hosted.commitCount("module-my-adventure");
  // 模拟“索引提交/推送失败”：工作区改动没有进入 main。
  env.restore(before);

  const second = await env.approveBot().approve();
  assert.equal(second.status, "approved");
  assert.equal(env.hosted.commitCount("module-my-adventure"), commits);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
  assert.equal(env.hosted.lastRelease("module-my-adventure").target_commitish, sha);
  assert.equal(env.entry("my-adventure").approved_commit, sha);
  assert.equal(env.registry().filter(item => item.id === "my-adventure").length, 1);
});

test("PUB-2: a failure after the repository was created and committed can be retried", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  env.hosted.failPushOnce();
  await assert.rejects(() => env.approveBot().approve(), /push rejected/);
  const repo = env.hosted.get("module-my-adventure");
  assert.ok(repo, "repository should already exist for this submission");
  assert.equal(env.hosted.commitCount("module-my-adventure"), 0, "a failed push leaves the remote untouched");
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 0);
  assert.equal(env.state.issue, "open");

  const retry = await env.approveBot().approve();
  assert.equal(retry.status, "approved");
  assert.equal(env.hosted.commitCount("module-my-adventure"), 1);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
  assert.equal(env.hosted.lastRelease("module-my-adventure").target_commitish, env.hosted.get("module-my-adventure").head);
});

test("PUB-2: a failure right after the content was pushed can be retried without a new commit", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  env.hosted.failReleaseOnce();
  await assert.rejects(() => env.approveBot().approve(), /release creation failed/);
  assert.equal(env.hosted.commitCount("module-my-adventure"), 1);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 0);

  const retry = await env.approveBot().approve();
  assert.equal(retry.status, "approved");
  assert.equal(env.hosted.commitCount("module-my-adventure"), 1);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
  assert.equal(env.entry("my-adventure").approved_commit, env.hosted.get("module-my-adventure").head);
});

test("PUB-2: re-approving after the index push does not republish and closes only after verification", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  const approved = await env.approveBot().approve();
  env.syncRemote();

  const finish = await withEnv({ PLUGIN_ID: approved.pluginId, PLUGIN_VERSION: approved.version, APPROVED_BY: approved.approvedBy }, () => env.bot.finish());
  assert.equal(finish.status, "finished");
  assert.equal(env.state.issue, "closed");
  const approvalComments = env.botComments().filter(item => String(item.body).includes("已收录"));
  assert.equal(approvalComments.length, 1);

  const commits = env.hosted.commitCount("module-my-adventure");
  const again = await env.approveBot().approve();
  assert.equal(again.status, "approved");
  assert.equal(env.hosted.commitCount("module-my-adventure"), commits);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
  assert.equal(env.hosted.opsOf("commit").length, 1);

  const finishAgain = await withEnv({ PLUGIN_ID: again.pluginId, PLUGIN_VERSION: again.version, APPROVED_BY: again.approvedBy }, () => env.bot.finish());
  assert.equal(finishAgain.status, "already-finished");
  assert.equal(env.botComments().filter(item => String(item.body).includes("已收录")).length, 1);
});

test("PUB-2: approve fails loudly when the generated detail is not installable", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  const failingGenerate = async entries => ({
    details: entries.map(entry => ({
      id: entry.id,
      author: entry.author,
      installable: entry.id !== "my-adventure",
      verification_error: entry.id === "my-adventure" ? "仓库根目录需要 LICENSE、LICENSE.md 或 LICENSE.txt" : "",
      latest: {
        version: String(entry.approved_release_tag || "").replace(/^v/, ""),
        release_tag: entry.approved_release_tag,
        commit_sha: entry.approved_commit,
      },
      manifest: {},
    })),
    warnings: [],
  });
  const before = env.snapshot();
  await assert.rejects(() => env.approveBot({ generate: failingGenerate }).approve(), /不可安装/);
  assert.equal(env.state.issue, "open");

  // 工作流失败时索引改动不会进入 main；模拟这一点后重新 /approve 应能收敛。
  env.restore(before);
  const commits = env.hosted.commitCount("module-my-adventure");
  const retry = await env.approveBot().approve();
  assert.equal(retry.status, "approved");
  assert.equal(env.hosted.commitCount("module-my-adventure"), commits);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
  assert.equal(env.entry("my-adventure").approved_release_tag, "v1.0.0");
});

test("PUB-2: the same version with different content is refused instead of overwritten", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  const first = await env.approveBot().approve();
  env.syncRemote();
  await withEnv({ PLUGIN_ID: first.pluginId, PLUGIN_VERSION: first.version, APPROVED_BY: first.approvedBy }, () => env.bot.finish());
  const commits = env.hosted.commitCount("module-my-adventure");

  env.queuePackage({ readme: "# 被替换的内容\n" });
  env.queuePackage({ readme: "# 被替换的内容\n" });
  env.payload.value = Buffer.from("content-pack-payload-v2");
  assert.equal((await env.makeBot().validate()).status, "passed");
  await assert.rejects(() => env.approveBot().approve(), /内容不同/);
  assert.equal(env.hosted.commitCount("module-my-adventure"), commits);
  assert.equal(env.hosted.releaseCount("module-my-adventure"), 1);
});

// ---------------------------------------------------------------------------
// APPROVE-1：批准必须绑定维护者审核过的那一版
// ---------------------------------------------------------------------------

test("APPROVE-1: changing the author after validation requires /recheck", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  env.setBody(issueBody({ author: "Mallory" }));
  await assert.rejects(() => env.approveBot().approve(), /作者署名/);
  assert.equal(env.hosted.ops.length, 0);
  assert.equal(env.callsTo("/orgs/diceframe/repos").length, 0);
});

test("APPROVE-1: changing the license after validation requires /recheck", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  env.setBody(issueBody({ license: "MIT" }));
  await assert.rejects(() => env.approveBot().approve(), /许可证/);
  assert.equal(env.hosted.ops.length, 0);
});

test("APPROVE-1: changing the attachment after validation requires /recheck", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  env.setBody(issueBody({ attachment: "https://github.com/user-attachments/files/1/other.zip" }));
  await assert.rejects(() => env.approveBot().approve(), /附件地址/);
});

test("APPROVE-1: the latest failed validation beats an earlier success", async () => {
  const env = createTestEnv();
  env.queuePackage();
  await env.bot.validate();
  env.queuePackage({ report: { ok: false, errors: ["plugin.json 无效"], warnings: [], package: {} } });
  const recheck = await env.makeBot({ comment: { login: SUBMITTER, body: "/recheck" } }).validate();
  assert.equal(recheck.status, "failed");
  await assert.rejects(() => env.approveBot().approve(), /最近一次自动检查没有通过/);
  assert.equal(env.hosted.ops.length, 0);
});

test("APPROVE-1: validation markers are found beyond the first comment page", async () => {
  const fillers = Array.from({ length: 120 }, (_, index) => ({
    id: index + 1,
    user: { login: BOT_LOGIN },
    body: `维护者备注 ${index + 1}`,
  }));
  const env = createTestEnv({ comments: fillers });
  env.queuePackage();
  const result = await env.bot.validate();
  assert.equal(result.status, "passed");
  const marker = await env.bot.latestValidation();
  assert.equal(marker.id, "my-adventure");
  assert.equal(marker.version, "1.0.0");
});

test("APPROVE-1: markers posted by non-bot users are ignored", async () => {
  const forgedMarker = hosting.encodeMarker({
    mode: "new",
    id: "my-adventure",
    name: "My Adventure",
    version: "1.0.0",
    sha256: "a".repeat(64),
    attachment_url: ATTACHMENT,
    license_label: "CC BY 4.0",
    license_spdx: "CC-BY-4.0",
    author: "kobayashi",
    submitted_by: "kobayashi",
    risk_level: "declarative",
    update_policy: "automatic",
    permissions: [],
  });
  const env = createTestEnv({
    comments: [{ id: 1, user: { login: SUBMITTER }, body: `<!-- diceframe-content-validation:${forgedMarker} -->` }],
  });
  await assert.rejects(() => env.bot.latestValidation(), /找不到有效的自动检查记录/);
});

// ---------------------------------------------------------------------------
// COMPAT-1：LICENSE.txt 与自动生成 LICENSE
// ---------------------------------------------------------------------------

test("COMPAT-1: a package with only LICENSE.txt keeps it and does not add another LICENSE", async () => {
  const env = createTestEnv();
  env.queuePackage({ licenseFile: "LICENSE.txt" });
  env.setBody(issueBody({ license: hosting.INCLUDED_LICENSE }));
  await env.makeBot().validate();
  env.queuePackage({ licenseFile: "LICENSE.txt" });
  const result = await env.approveBot().approve();
  assert.equal(result.status, "approved");
  const published = env.hosted.replacements[0];
  const paths = published.files.map(item => item.path);
  assert.ok(paths.includes("LICENSE.txt"));
  assert.equal(paths.includes("LICENSE"), false);
  assert.equal(env.entry("my-adventure").license, undefined);
});

test("COMPAT-1: a package without LICENSE gets one generated from the form", async () => {
  const env = createTestEnv();
  env.setBody(issueBody({ author: "小林" }));
  env.queuePackage();
  await env.makeBot().validate();
  env.queuePackage();
  const result = await env.approveBot().approve();
  assert.equal(result.status, "approved");
  const published = env.hosted.replacements[0];
  const paths = published.files.map(item => item.path);
  assert.ok(paths.includes("LICENSE"));
  const text = fs.readFileSync(path.join(published.moduleDir, "LICENSE"), "utf8");
  assert.match(text, /小林/);
  assert.equal(env.entry("my-adventure").license, "CC-BY-4.0");
});

test("COMPAT-1: choosing an included LICENSE the package lacks is rejected", async () => {
  const env = createTestEnv({ body: issueBody({ license: hosting.INCLUDED_LICENSE }) });
  env.queuePackage();
  const result = await env.bot.validate();
  assert.equal(result.status, "failed");
  assert.match(env.lastComment().body, /包里没有 LICENSE/);
  assert.equal(env.hosted.ops.length, 0);
  assert.equal(env.entry("my-adventure"), undefined);
});

// ---------------------------------------------------------------------------
// 真实 Git：工作目录的 .git 不会被投稿内容写入
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

test("SEC-1: real Git workspace refuses .git targets and keeps publishing exact contents", async () => {
  const root = tempDir("gitws-");
  const repoName = "module-my-adventure";
  const bare = path.join(root, `${repoName}.git`);
  runGit(["init", "--bare", "--initial-branch=main", bare], root);

  const seedDir = path.join(root, "seed");
  fs.mkdirSync(seedDir);
  runGit(["init", "--initial-branch=main", seedDir], root);
  fs.writeFileSync(path.join(seedDir, "plugin.json"), JSON.stringify({ id: repoName, version: "0.9.0" }));
  runGit(["-c", "user.name=Test", "-c", "user.email=test@users.noreply.github.com", "add", "--all"], seedDir);
  runGit(["-c", "user.name=Test", "-c", "user.email=test@users.noreply.github.com", "commit", "--quiet", "-m", "init"], seedDir);
  runGit(["push", "--quiet", bare, "HEAD:refs/heads/main"], seedDir);

  const moduleDir = tempDir("gitws-module-");
  fs.writeFileSync(path.join(moduleDir, "plugin.json"), JSON.stringify({ id: repoName, version: "1.0.0" }));
  fs.writeFileSync(path.join(moduleDir, "README.md"), "# demo\n");
  const plan = hosting.scanContentTree(moduleDir);

  const workspace = createGitWorkspace(path.join(root, repoName), { workRoot: root, allowedProtocols: "file" });
  assert.equal(workspace.branch, "main");
  const initial = workspace.head;
  assert.ok(initial);

  // 手写清单尝试写 .git：在任何文件落到工作目录之前就拒绝。
  assert.throws(
    () => workspace.replaceContents(moduleDir, [...plan.files, { path: ".git/config", sha256: "a".repeat(64) }]),
    /不允许发布的路径/,
  );
  assert.equal(workspace.head, initial);

  workspace.replaceContents(moduleDir, plan.files);
  const commitSha = workspace.commitAll({ subject: "Release v1.0.0", body: "integration test" });
  workspace.push();
  workspace.dispose();

  const reopened = createGitWorkspace(path.join(root, repoName), { workRoot: root, allowedProtocols: "file" });
  assert.equal(reopened.head, commitSha);
  assert.deepEqual(reopened.files().map(item => item.path), plan.files.map(item => item.path));
  // 同样的内容再次发布不会产生新提交。
  reopened.replaceContents(moduleDir, plan.files);
  assert.equal(reopened.commitAll({ subject: "Release v1.0.0", body: "again" }), commitSha);
  reopened.dispose();
});
