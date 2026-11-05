"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LICENSE_FILE_NAMES,
  addedPermissions,
  classifyManifest,
  detailFromSnapshot,
  effectivePermissions,
  loadReleaseSnapshot,
  normalizeRepositoryUrl,
  parseSubmission,
  validateRegistry,
  validateManifest,
} = require("../scripts/registry.cjs");

const baseManifest = {
  schema_version: 1,
  id: "demo-pack",
  name: "Demo",
  version: "1.2.3",
  description: "Demo pack",
  plugin_type: "content-pack",
  permissions: ["content.read"],
};

test("parses the GitHub issue form", () => {
  const result = parseSubmission("### 插件 ID / Plugin ID\n\ndemo-pack\n\n### 仓库地址 / Repository URL\n\nhttps://github.com/example/demo-pack\n");
  assert.equal(result.id, "demo-pack");
  assert.equal(result.repositoryUrl, "https://github.com/example/demo-pack");
});

test("normalizes a public GitHub repository URL", () => {
  assert.deepEqual(normalizeRepositoryUrl("https://github.com/example/demo.git"), {
    url: "https://github.com/example/demo", owner: "example", repo: "demo",
  });
  assert.throws(() => normalizeRepositoryUrl("https://example.com/repo"));
});

test("declarative plugins can auto-update", () => {
  assert.equal(classifyManifest(baseManifest).updatePolicy, "automatic");
});

test("voice presets are installable declarative plugins", () => {
  const manifest = {
    ...baseManifest,
    id: "voice-presets",
    plugin_type: "voice-pack",
    permissions: undefined,
  };
  assert.doesNotThrow(() => validateManifest(
    manifest,
    "voice-presets",
    "https://github.com/example/voice-presets",
  ));
  assert.equal(classifyManifest(manifest).riskLevel, "declarative");
  assert.deepEqual(effectivePermissions(manifest), ["plugin.config", "voice.assets"]);
});

test("process plugins only notify about updates", () => {
  const policy = classifyManifest({ ...baseManifest, plugin_type: "channel-adapter", entrypoint: ["{python}", "main.py"] });
  assert.equal(policy.riskLevel, "unrestricted-process");
  assert.equal(policy.updatePolicy, "notify");
});

test("manifest validation rejects unknown permissions", () => {
  assert.throws(
    () => validateManifest({ ...baseManifest, permissions: ["system.everything"] }, "demo-pack", "https://github.com/example/demo"),
    /未知权限/,
  );
});

test("permission expansion is detected", () => {
  assert.deepEqual(addedPermissions(["content.read"], ["content.read", "network.client"]), ["network.client"]);
});

test("detailFromSnapshot carries the GitHub star count", () => {
  const entry = {
    id: "demo-pack",
    repository_url: "https://github.com/example/demo-pack",
    approved_permissions: ["content.read"],
    risk_level: "declarative",
    trust_level: "community",
  };
  const snapshot = {
    id: "demo-pack",
    repositoryUrl: "https://github.com/example/demo-pack",
    owner: "example",
    repo: "demo-pack",
    branch: "main",
    stars: 42,
    releaseTag: "v1.0.0",
    releaseUrl: "https://github.com/example/demo-pack/releases/tag/v1.0.0",
    commitSha: "0".repeat(40),
    manifest: baseManifest,
    riskLevel: "declarative",
    updatePolicy: "automatic",
    permissions: ["content.read"],
  };
  const detail = detailFromSnapshot(entry, snapshot);
  assert.equal(detail.stars, 42);
  assert.equal(detail.author, "example");
  assert.equal(detail.id, "demo-pack");
  assert.equal(detail.installable, true);
  assert.deepEqual(detail.latest, {
    version: "1.2.3",
    release_tag: "v1.0.0",
    release_url: "https://github.com/example/demo-pack/releases/tag/v1.0.0",
    commit_sha: "0".repeat(40),
    published_at: "",
    requires_approval: false,
  });
});

test("latest marks requires_approval when permissions expand", () => {
  const entry = {
    id: "demo-pack",
    repository_url: "https://github.com/example/demo-pack",
    approved_permissions: ["content.read"],
    risk_level: "declarative",
    trust_level: "community",
  };
  const snapshot = {
    id: "demo-pack",
    repositoryUrl: "https://github.com/example/demo-pack",
    owner: "example",
    repo: "demo-pack",
    branch: "main",
    stars: 0,
    releaseTag: "v1.1.0",
    releaseUrl: "https://github.com/example/demo-pack/releases/tag/v1.1.0",
    publishedAt: "2026-08-01T10:00:00Z",
    commitSha: "1".repeat(40),
    manifest: { ...baseManifest, version: "1.3.0", permissions: ["content.read", "network.client"] },
    riskLevel: "declarative",
    updatePolicy: "automatic",
    permissions: ["content.read", "network.client"],
  };
  const detail = detailFromSnapshot(entry, snapshot);
  assert.equal(detail.latest.requires_approval, true);
  assert.equal(detail.update_policy, "approval-required");
  assert.equal(detail.installable, false);
});

test("permissions are inferred exactly like the host when omitted", () => {
  assert.deepEqual(
    effectivePermissions({ ...baseManifest, permissions: undefined }),
    ["content.import", "content.read", "plugin.config"],
  );
  assert.deepEqual(
    effectivePermissions({
      ...baseManifest,
      permissions: undefined,
      contributes: { map_backgrounds: ["maps/*.webp"] },
    }),
    ["content.import", "content.read", "map.assets", "plugin.config"],
  );
});

test("registry validation rejects duplicate IDs and mismatched details", () => {
  const entry = {
    id: "demo-pack",
    repository_url: "https://github.com/example/demo-pack",
    update_policy: "automatic",
    approved_permissions: ["content.read"],
  };
  assert.equal(validateRegistry([entry], [{ id: "demo-pack" }]), true);
  assert.throws(() => validateRegistry([entry, entry], [{ id: "demo-pack" }]), /重复插件 ID/);
  assert.throws(() => validateRegistry([entry], [{ id: "other-pack" }]), /ID 不一致/);
});

// COMPAT-1：索引侧与主仓库校验器识别同一组许可证文件名。
function snapshotFetch(licenseFiles) {
  const commitSha = "0".repeat(40);
  const file = text => ({ type: "file", encoding: "base64", content: Buffer.from(text, "utf8").toString("base64") });
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const missing = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  return async url => {
    const href = String(url);
    if (href.endsWith("/repos/example/demo-pack")) {
      return json({ private: false, archived: false, disabled: false, default_branch: "main", stargazers_count: 3 });
    }
    if (href.endsWith("/releases/latest")) {
      return json({ draft: false, prerelease: false, tag_name: "v1.0.0", html_url: "https://github.com/example/demo-pack/releases/tag/v1.0.0" });
    }
    if (href.includes(`/commits/${encodeURIComponent("v1.0.0")}`)) return json({ sha: commitSha });
    if (href.includes("/contents/plugin.json?")) return json(file(JSON.stringify(baseManifest)));
    if (href.includes("/git/trees/")) return json({ truncated: false, tree: [{ type: "blob", path: "plugin.json", size: 10 }] });
    if (href.includes("/contents/config.schema.json?")) return json(file("{}"));
    if (href.includes("/contents/README.md?")) return json(file("# demo\n"));
    if (href.includes("/contents/")) {
      const name = decodeURIComponent(href.split("/contents/")[1].split("?")[0]);
      if (licenseFiles.includes(name)) return json(file("license text\n"));
      return missing();
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

test("COMPAT-1: LICENSE.txt alone is enough for a hosted release snapshot", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = snapshotFetch(["LICENSE.txt"]);
    const snapshot = await loadReleaseSnapshot("https://github.com/example/demo-pack", "demo-pack", "token");
    const detail = detailFromSnapshot({
      id: "demo-pack",
      repository_url: "https://github.com/example/demo-pack",
      approved_permissions: ["content.read"],
      risk_level: "declarative",
      trust_level: "community",
    }, snapshot);
    assert.equal(detail.installable, true);
    assert.equal(detail.latest.version, "1.2.3");
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(LICENSE_FILE_NAMES, ["LICENSE", "LICENSE.md", "LICENSE.txt"]);
});

test("COMPAT-1: a repository without any recognized LICENSE is rejected", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = snapshotFetch([]);
    await assert.rejects(
      () => loadReleaseSnapshot("https://github.com/example/demo-pack", "demo-pack", "token"),
      /LICENSE、LICENSE\.md 或 LICENSE\.txt/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
