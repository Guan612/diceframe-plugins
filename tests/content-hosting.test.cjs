"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const hosting = require("../scripts/content-hosting.cjs");
const { detailFromSnapshot, validateRegistry } = require("../scripts/registry.cjs");

const ISSUE_BODY = [
  "### 插件 ID / Plugin ID",
  "",
  "my-adventure",
  "",
  "### 插件包 / Package",
  "",
  "[my-adventure-1.0.0.zip](https://github.com/user-attachments/files/19876543/my-adventure-1.0.0.zip)",
  "",
  "### 作者署名 / Author",
  "",
  "_No response_",
  "",
  "### 许可证 / License",
  "",
  "CC BY 4.0",
  "",
  "### 投稿确认 / Confirmation",
  "",
  "- [X] 内容是我原创的，或者我已获得改编和分发的授权",
  "",
  "### 补充说明 / Additional information",
  "",
  "_No response_",
].join("\n");

const okReport = {
  ok: true,
  errors: [],
  warnings: [],
  adventures: [{ adventure_id: "plugin:demo" }],
  package: { plugin_id: "my-adventure", plugin_type: "content-pack", has_readme: true, has_license: false },
};

const marker = {
  mode: "new",
  id: "my-adventure",
  name: "My Adventure",
  version: "1.0.0",
  sha256: "a".repeat(64),
  attachment_url: "https://github.com/user-attachments/files/19876543/my-adventure-1.0.0.zip",
  license_label: "CC BY 4.0",
  license_spdx: "CC-BY-4.0",
  author: "小林",
  submitted_by: "kobayashi",
  risk_level: "declarative",
  update_policy: "automatic",
  permissions: ["content.import", "content.read", "plugin.config"],
};
const approval = { by: "maintainer", at: "2026-11-05T00:00:00.000Z" };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, relative, content = "x") {
  const absolute = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

function hashOf(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("parses the content pack issue form", () => {
  assert.deepEqual(hosting.parseContentSubmission(ISSUE_BODY), {
    id: "my-adventure",
    attachments: ["https://github.com/user-attachments/files/19876543/my-adventure-1.0.0.zip"],
    author: "",
    license: "CC BY 4.0",
    note: "",
  });
});

test("only GitHub-hosted .zip attachments are accepted", () => {
  const text = [
    "https://github.com/user-attachments/files/1/a.zip",
    "https://github.com/user-attachments/files/1/a.zip",
    "https://github.com/owner/repo/files/2/legacy.ZIP",
    "https://github.com/user-attachments/files/3/notes.md",
    "https://example.com/user-attachments/files/4/evil.zip",
    "https://github.com.evil.example/user-attachments/files/5/evil.zip",
  ].join("\n");
  assert.deepEqual(hosting.attachmentUrls(text), [
    "https://github.com/user-attachments/files/1/a.zip",
    "https://github.com/owner/repo/files/2/legacy.ZIP",
  ]);
});

test("a submission needs exactly one attachment", () => {
  assert.throws(() => hosting.singleAttachment({ attachments: [] }), /没有找到 \.zip 附件/);
  assert.throws(() => hosting.singleAttachment({ attachments: ["a", "b"] }), /只能放一个/);
  assert.equal(hosting.singleAttachment({ attachments: ["a"] }), "a");
});

test("hosted repositories live under the diceframe organization", () => {
  assert.deepEqual(hosting.hostedRepository("my-adventure"), {
    owner: "diceframe",
    repo: "module-my-adventure",
    url: "https://github.com/diceframe/module-my-adventure",
  });
  assert.throws(() => hosting.hostedRepository("../escape"), /格式无效/);
  assert.throws(() => hosting.hostedRepository(""), /格式无效/);
});

test("license choices map to SPDX identifiers", () => {
  assert.equal(hosting.licenseChoice("CC BY-NC 4.0").spdx, "CC-BY-NC-4.0");
  assert.deepEqual(hosting.licenseChoice(hosting.INCLUDED_LICENSE), {
    label: hosting.INCLUDED_LICENSE, included: true, spdx: "",
  });
  assert.throws(() => hosting.licenseChoice("GPL-3.0"), /请选择许可证/);
});

test("versions compare numerically and prereleases sort by SemVer identifiers", () => {
  assert.equal(hosting.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(hosting.compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(hosting.compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(hosting.compareVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.throws(() => hosting.compareVersions("1.0", "1.0.0"), /版本号格式无效/);

  // VERSION-1：字符串比较会把 rc.10 判成比 rc.2 小。
  assert.equal(hosting.compareVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  assert.equal(hosting.compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(hosting.compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(hosting.compareVersions("1.0.0-beta.1", "1.0.0-beta.2"), -1);
  assert.equal(hosting.compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(hosting.compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(hosting.compareVersions("1.0.0-2", "1.0.0-alpha"), -1);
  assert.equal(hosting.compareVersions("1.0.0-rc.01", "1.0.0-rc.1"), 0);
});

test("submission mode separates new packs, updates and taken IDs", () => {
  const hosted = { id: "my-adventure", hosted: true, submitted_by: "kobayashi", repository_url: "https://github.com/diceframe/module-my-adventure" };
  const repository = { id: "office-night", repository_url: "https://github.com/EOEOY/office-night" };
  assert.deepEqual(hosting.submissionMode([], "my-adventure", "kobayashi", false), { mode: "new", entry: null });
  assert.equal(hosting.submissionMode([hosted], "my-adventure", "kobayashi", false).mode, "update");
  assert.equal(hosting.submissionMode([hosted], "my-adventure", "someone", true).mode, "update");
  assert.throws(() => hosting.submissionMode([hosted], "my-adventure", "someone", false), /只有原投稿者或维护者/);
  assert.throws(() => hosting.submissionMode([repository], "office-night", "kobayashi", true), /已被 https:\/\/github.com\/EOEOY\/office-night 使用/);
});

test("the validator report must pass and match the submission", () => {
  const license = hosting.licenseChoice("CC BY 4.0");
  assert.equal(hosting.checkPackageReport(okReport, { id: "my-adventure", license }).plugin_id, "my-adventure");
  assert.throws(
    () => hosting.checkPackageReport({ ok: false, errors: ["adventure_package_invalid:demo:node type is invalid"] }, { id: "my-adventure", license }),
    /- adventure_package_invalid:demo:node type is invalid/,
  );
  assert.throws(() => hosting.checkPackageReport(okReport, { id: "other", license }), /不一致/);
  assert.throws(
    () => hosting.checkPackageReport({ ...okReport, package: { ...okReport.package, plugin_type: "theme" } }, { id: "my-adventure", license }),
    /只收内容包/,
  );
  assert.throws(
    () => hosting.checkPackageReport({ ...okReport, package: { ...okReport.package, has_readme: false } }, { id: "my-adventure", license }),
    /README/,
  );
  assert.throws(
    () => hosting.checkPackageReport(okReport, { id: "my-adventure", license: hosting.licenseChoice(hosting.INCLUDED_LICENSE) }),
    /包里没有 LICENSE/,
  );
  // 与主仓库校验器一致：LICENSE.txt 也算自带许可证。
  assert.doesNotThrow(() => hosting.checkPackageReport(
    { ...okReport, package: { ...okReport.package, has_license: true } },
    { id: "my-adventure", license: hosting.licenseChoice(hosting.INCLUDED_LICENSE) },
  ));
});

test("generated licenses name the author", () => {
  const mit = hosting.licenseFileText({ license: hosting.licenseChoice("MIT"), author: "小林", name: "Demo", year: 2026 });
  assert.match(mit, /^MIT License\n\nCopyright \(c\) 2026 小林\n/);
  assert.doesNotMatch(mit, /<year>|<copyright holders>/);
  const ccBy = hosting.licenseFileText({ license: hosting.licenseChoice("CC BY 4.0"), author: "小林", name: "Demo", year: 2026 });
  assert.match(ccBy, /^Demo\nCopyright \(c\) 2026 小林\n\nLicensed under CC BY 4\.0 \(CC-BY-4\.0\)/);
  assert.match(ccBy, /Creative Commons Attribution 4\.0 International/);
  const cc0 = hosting.licenseFileText({ license: hosting.licenseChoice("CC0 1.0"), author: "小林", name: "Demo", year: 2026 });
  assert.match(cc0, /^Demo\nDedicated to the public domain by 小林 \(2026\)/);
  assert.equal(hosting.licenseFileText({ license: hosting.licenseChoice(hosting.INCLUDED_LICENSE), author: "x", name: "y", year: 2026 }), null);
});

test("hosted entries pass registry validation and keep the author", () => {
  const release = { tag: "v1.0.0", commitSha: "a".repeat(40) };
  const entry = hosting.hostedEntry(marker, release, approval);
  assert.equal(entry.repository_url, "https://github.com/diceframe/module-my-adventure");
  assert.equal(entry.trust_level, "community");
  assert.equal(entry.license, "CC-BY-4.0");
  assert.doesNotThrow(() => validateRegistry([entry], [{ id: "my-adventure" }]));

  const updated = hosting.updatedHostedEntry(entry, { ...marker, mode: "update", license_spdx: "", author: "小林工作室" }, { tag: "v1.1.0", commitSha: "b".repeat(40) }, approval);
  assert.equal(updated.approved_release_tag, "v1.1.0");
  assert.equal(updated.submitted_by, "kobayashi");
  assert.equal(updated.author, "小林工作室");
  assert.equal("license" in updated, false);
  assert.doesNotThrow(() => validateRegistry([updated], [{ id: "my-adventure" }]));
});

test("registry rejects malformed hosted entries", () => {
  const entry = hosting.hostedEntry(marker, { tag: "v1.0.0", commitSha: "a".repeat(40) }, approval);
  assert.throws(() => validateRegistry([{ ...entry, repository_url: "https://github.com/someone/my-adventure" }], [{ id: "my-adventure" }]), /仓库地址必须是/);
  assert.throws(() => validateRegistry([{ ...entry, trust_level: "official" }], [{ id: "my-adventure" }]), /trust_level 必须是 community/);
  assert.throws(() => validateRegistry([{ ...entry, author: " " }], [{ id: "my-adventure" }]), /author 不能为空/);
  assert.throws(() => validateRegistry([{ ...entry, hosted: "yes" }], [{ id: "my-adventure" }]), /hosted 只能是 true/);
});

test("details show the submitted author instead of the hosting organization", () => {
  const entry = hosting.hostedEntry(marker, { tag: "v1.0.0", commitSha: "a".repeat(40) }, approval);
  const detail = detailFromSnapshot(entry, {
    branch: "main", owner: "diceframe", repo: "module-my-adventure", stars: 0,
    releaseTag: "v1.0.0", releaseUrl: "", commitSha: "a".repeat(40), publishedAt: "",
    manifest: { version: "1.0.0" }, permissions: marker.permissions,
    riskLevel: "declarative", updatePolicy: "automatic",
  });
  assert.equal(detail.author, "小林");
  assert.equal(detail.license, "CC-BY-4.0");
  assert.equal(detail.installable, true);
});

test("validation markers round-trip and reject forged or malformed payloads", () => {
  const body = `text\n\n<!-- diceframe-content-validation:${hosting.encodeMarker(marker)} -->`;
  const decoded = hosting.decodeMarker(body);
  assert.equal(decoded.snapshot_version, 1);
  for (const key of Object.keys(marker)) assert.deepEqual(decoded[key], marker[key]);
  assert.equal(hosting.decodeMarker("<!-- diceframe-validation:abc -->"), null);
  // 缺少 snapshot_version 的旧格式 / 手工伪造内容一律不认。
  const legacy = Buffer.from(JSON.stringify(marker)).toString("base64url");
  assert.equal(hosting.decodeMarker(`<!-- diceframe-content-validation:${legacy} -->`), null);
  assert.equal(hosting.decodeMarker(`<!-- diceframe-content-validation:${hosting.encodeMarker({ ...marker, id: "../escape" })} -->`), null);
  assert.equal(hosting.decodeMarker(`<!-- diceframe-content-validation:${hosting.encodeMarker({ ...marker, sha256: "abc" })} -->`), null);
  assert.equal(hosting.decodeMarker(`<!-- diceframe-content-validation:${"A".repeat(20000)} -->`), null);
});

test("publish state markers round-trip", () => {
  const state = {
    id: "my-adventure", version: "1.0.0", sha256: "a".repeat(64),
    repository: "diceframe/module-my-adventure", commit_sha: "b".repeat(40),
    release_tag: "v1.0.0", status: "released", approved_by: "maintainer",
    updated_at: "2026-11-06T00:00:00.000Z",
  };
  const body = `status\n\n<!-- diceframe-content-publish:${hosting.encodePublishState(state)} -->`;
  assert.deepEqual(hosting.decodePublishState(body), state);
  assert.equal(hosting.decodePublishState(`<!-- diceframe-content-publish:${hosting.encodePublishState({ ...state, status: "done" })} -->`), null);
  assert.equal(hosting.decodePublishState("<!-- diceframe-content-validation:abc -->"), null);
});

test("snapshots detect author, license and content changes", () => {
  assert.deepEqual(hosting.diffSnapshots(marker, { ...marker }), []);
  assert.deepEqual(hosting.diffSnapshots(marker, { ...marker, mode: "update" }), []);
  assert.deepEqual(hosting.diffSnapshots(marker, { ...marker, author: "Mallory" }), ["author"]);
  assert.deepEqual(hosting.diffSnapshots(marker, { ...marker, license_label: "MIT", license_spdx: "MIT" }), ["license_label", "license_spdx"]);
  assert.deepEqual(hosting.diffSnapshots(marker, { ...marker, sha256: "b".repeat(64) }), ["sha256"]);
  assert.deepEqual(hosting.diffSnapshots(marker, { ...marker, permissions: [...marker.permissions, "network.client"] }), ["permissions"]);
});

test("content scans reject Git metadata, symlinks and case collisions", (t) => {
  const root = tempDir("scan-ok-");
  writeFile(root, "plugin.json", "{}");
  writeFile(root, "adventures/one.json", "{}");
  const scan = hosting.scanContentTree(root);
  assert.deepEqual(scan.files.map(item => item.path), ["adventures/one.json", "plugin.json"]);
  assert.equal(scan.files[0].sha256, hashOf("{}"));

  const badTrees = [
    [".git/config", "[core]\n\thooksPath = /tmp/evil\n"],
    ["nested/.git/config", "[core]\n\tfsmonitor = /tmp/evil\n"],
    [".GIT/HEAD", "ref: refs/heads/main\n"],
    [".gitattributes", "* filter=evil\n"],
    ["sub/.gitattributes", "*.json working-tree-encoding=UTF-16\n"],
    [".GITATTRIBUTES", "* -text\n"],
    [".gitignore", "plugin.json\n"],
    ["assets/.gitmodules", "[submodule \"x\"]\n"],
    [".lfsconfig", "[lfs]\n"],
    [".github/workflows/publish.yml", "on: push\n"],
    [".GitLab-ci.yml", "script: evil\n"],
  ];
  for (const [relative, content] of badTrees) {
    const dir = tempDir("scan-bad-");
    writeFile(dir, "plugin.json", "{}");
    writeFile(dir, relative, content);
    assert.throws(() => hosting.scanContentTree(dir), /不允许发布的 Git 元数据或 CI 配置/, `${relative} should be rejected`);
  }

  const symlinkRoot = tempDir("scan-link-");
  writeFile(symlinkRoot, "plugin.json", "{}");
  try {
    fs.symlinkSync("/etc/hostname", path.join(symlinkRoot, "leak.txt"));
  } catch {
    t.diagnostic("symlink not supported on this platform; skipped symlink assertion");
  }
  if (fs.existsSync(path.join(symlinkRoot, "leak.txt"))) {
    assert.throws(() => hosting.scanContentTree(symlinkRoot), /符号链接/);
  }

  const caseRoot = tempDir("scan-case-");
  writeFile(caseRoot, "Plugin.json", "a");
  writeFile(caseRoot, "plugin.json", "b");
  if (fs.readdirSync(caseRoot).length === 2) {
    assert.throws(() => hosting.scanContentTree(caseRoot), /大小写不同的同名文件/);
  } else {
    t.diagnostic("case-insensitive filesystem; skipped case collision assertion");
  }
});

test("content copies write only verified regular files and never touch .git", () => {
  const source = tempDir("copy-src-");
  writeFile(source, "plugin.json", "{\"id\":\"demo\"}");
  writeFile(source, "adventures/one.json", "{}");
  const plan = hosting.scanContentTree(source);

  const destination = tempDir("copy-dest-");
  const gitConfig = writeFile(destination, ".git/config", "[core]\n\trepositoryformatversion = 0\n");
  const gitHead = writeFile(destination, ".git/HEAD", "ref: refs/heads/main\n");

  hosting.copyContentTree(plan.files, source, destination);
  assert.equal(fs.readFileSync(gitConfig, "utf8"), "[core]\n\trepositoryformatversion = 0\n");
  assert.equal(fs.readFileSync(gitHead, "utf8"), "ref: refs/heads/main\n");
  assert.equal(fs.readFileSync(path.join(destination, "plugin.json"), "utf8"), "{\"id\":\"demo\"}");

  const nested = path.join(destination, "adventures", "one.json");
  assert.equal(fs.readFileSync(nested, "utf8"), "{}");

  // 即使传入手写的清单，复制器也拒绝任何落在 .git 里的目标。
  assert.throws(
    () => hosting.copyContentTree([{ path: ".git/config", sha256: "a".repeat(64) }], source, destination),
    /不允许发布的路径/,
  );
  assert.throws(
    () => hosting.copyContentTree([{ path: "../escape.json", sha256: "a".repeat(64) }], source, destination),
    /无效路径/,
  );

  const tampered = hosting.scanContentTree(source);
  tampered.files[0].sha256 = "b".repeat(64);
  assert.throws(() => hosting.copyContentTree(tampered.files, source, tempDir("copy-tamper-")), /复制后内容校验失败/);
});

test("published details must be installable and match the approved submission", () => {
  const release = { tag: "v1.0.0", commitSha: "a".repeat(40) };
  const detail = {
    id: "my-adventure",
    author: "小林",
    license: "CC-BY-4.0",
    installable: true,
    latest: { version: "1.0.0", release_tag: "v1.0.0", commit_sha: "a".repeat(40) },
  };
  assert.equal(hosting.verifyPublishedDetail(detail, marker, release), true);
  assert.throws(
    () => hosting.verifyPublishedDetail({ ...detail, installable: false, verification_error: "仓库根目录需要 LICENSE" }, marker, release),
    /不可安装：仓库根目录需要 LICENSE/,
  );
  assert.throws(() => hosting.verifyPublishedDetail({ ...detail, author: "diceframe" }, marker, release), /作者/);
  assert.throws(
    () => hosting.verifyPublishedDetail({ ...detail, latest: { ...detail.latest, version: "1.0.1" } }, marker, release),
    /版本/,
  );
  assert.throws(
    () => hosting.verifyPublishedDetail({ ...detail, latest: { ...detail.latest, commit_sha: "c".repeat(40) } }, marker, release),
    /提交/,
  );
  assert.throws(() => hosting.verifyPublishedDetail(undefined, marker, release), /缺少/);
});

test("hosted entry identity checks reject foreign repositories", () => {
  const entry = hosting.hostedEntry(marker, { tag: "v1.0.0", commitSha: "a".repeat(40) }, approval);
  assert.doesNotThrow(() => hosting.assertHostedEntryIdentity(entry, "my-adventure"));
  assert.throws(
    () => hosting.assertHostedEntryIdentity({ ...entry, hosted: false }, "my-adventure"),
    /不是托管内容包/,
  );
  assert.throws(
    () => hosting.assertHostedEntryIdentity({ ...entry, repository_url: "https://github.com/someone/module-my-adventure" }, "my-adventure"),
    /托管仓库地址/,
  );
  assert.throws(
    () => hosting.assertHostedEntryIdentity({ ...entry, approved_release_tag: "" }, "my-adventure"),
    /Release 记录/,
  );
  assert.throws(
    () => hosting.assertHostedEntryIdentity({ ...entry, approved_commit: "abc" }, "my-adventure"),
    /提交记录/,
  );
});
