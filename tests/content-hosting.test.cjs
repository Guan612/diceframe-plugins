"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
  version: "1.0.0",
  author: "小林",
  submitted_by: "kobayashi",
  license_spdx: "CC-BY-4.0",
  risk_level: "declarative",
  update_policy: "automatic",
  permissions: ["content.import", "content.read", "plugin.config"],
};
const approval = { by: "maintainer", at: "2026-11-05T00:00:00.000Z" };

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

test("versions compare numerically and prereleases sort before releases", () => {
  assert.equal(hosting.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(hosting.compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(hosting.compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(hosting.compareVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.throws(() => hosting.compareVersions("1.0", "1.0.0"), /版本号格式无效/);
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

test("validation markers round-trip through a comment", () => {
  const body = `text\n\n<!-- diceframe-content-validation:${hosting.encodeMarker(marker)} -->`;
  assert.deepEqual(hosting.decodeMarker(body), marker);
  assert.equal(hosting.decodeMarker("<!-- diceframe-validation:abc -->"), null);
});
