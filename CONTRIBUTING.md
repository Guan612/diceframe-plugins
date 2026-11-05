# DiceFrame 插件收录指南

中文 | [English](CONTRIBUTING_EN.md)

## 作者需要准备什么

插件必须放在独立、公开的 GitHub 仓库中，且仓库根目录就是插件目录。纯内容包也可以不建仓库，见[没有自己的仓库：投稿内容包](#没有自己的仓库投稿内容包)。根目录至少包含：

- `plugin.json`
- `README_CN.md` 或 `README.md`
- `LICENSE`、`LICENSE.md` 或 `LICENSE.txt`
- `config.schema.json`（如果 `plugin.json.config_schema` 声明了它）

插件必须先创建至少一个非草稿、非预发布的 GitHub Release。Release 指向的版本中，`plugin.json.version` 必须使用三段式版本号，例如 `1.0.0`。

作者不需要上传插件 ZIP，也不需要计算 SHA-256。DiceFrame 使用 Release 所指向的固定 Git commit 下载仓库源码快照。

## 第一次投稿

1. 打开 [添加插件](https://github.com/diceframe/diceframe-plugins/issues/new/choose)。
2. 填写插件 ID 和公开仓库地址。
3. 等待机器人评论检查结果。
4. 如果失败，按错误修改自己的仓库，然后回复 `/recheck`。
5. 检查通过后等待维护者批准。

作者不应修改本仓库的 `plugins.json` 或 `plugin_details.json`。Pull Request 投稿方式不再使用。

## 后续更新

发布更新时，作者只需：

1. 更新 `plugin.json.version`。
2. 提交代码并创建新的 Git tag。
3. 创建非草稿、非预发布的 GitHub Release。

声明型插件在权限和运行方式不变时，用户打开插件商店时会自动检查并更新。进程型插件只通知用户。增加权限、从声明型改为进程型、转移仓库或更换插件 ID 时，必须重新提交审核。

## 没有自己的仓库：投稿内容包

冒险模组、世界、规则、角色卡这类纯内容包（不含可执行程序）可以不建 GitHub 仓库：

1. 在 DiceFrame 里导出内容包，把文件改名为 `.zip`（GitHub 不接受 `.dfplugin` 后缀）。
2. 打开 [投稿内容包](https://github.com/diceframe/diceframe-plugins/issues/new?template=add-content-pack.yml)，填写插件 ID、作者署名和许可证，把 `.zip` 拖进「插件包」一栏。
3. 机器人用 DiceFrame 自己的校验器检查这个包：解压规则和客户端安装时一致，冒险、引用和语言文件都会真实加载一遍。失败时按提示修改，重新上传后编辑 Issue，或回复 `/recheck`。
4. 检查通过后由维护者审核。批准后，DiceFrame 在 diceframe 组织下建 `module-<插件 ID>` 仓库，推送包内容，发布 `v<版本号>` Release，并加入索引。
5. 包里没有许可证文件时，按表单里选的许可证生成一份，署名为作者；包里有 `LICENSE`、`LICENSE.md` 或 `LICENSE.txt` 时以包里的为准。

更新时用同一个表单再投一次，版本号要比已收录的高；只有原投稿者或维护者可以更新同一个包。商店显示的作者是投稿时填写的署名，信任等级为社区（community）。

没有 GitHub 账号的作者可以请维护者代投稿，在「补充说明」里写明作者。

### 维护者配置

批准步骤需要仓库 Secret `CONTENT_HOSTING_TOKEN`：能在 diceframe 组织下创建公开仓库、推送内容和发布 Release 的凭据（组织的 fine-grained token 或 GitHub App 安装令牌，需要 Administration 和 Contents 的读写权限）。没有配置时 `/approve` 会直接报错，不会建任何仓库。

批准中途失败（例如索引推送失败）时可以再回复一次 `/approve`：已经创建的仓库、提交和 Release 会按记录沿用，不会重复发布；同名但不是这次投稿创建的仓库会被拒绝，不会被清空或覆盖。

## 自动检查范围

自动检查会验证：

- GitHub 仓库公开、未归档，URL 与插件声明一致。
- 最新 Release、tag、固定 commit 和 `plugin.json` 可读取。
- 插件 ID、版本、类型、权限和必填字段合法。
- README、LICENSE 和配置 Schema 存在。
- 文件数量、总体积不超过安装限制。
- 没有 `.env`、私钥、凭据 JSON 等明显秘密文件。
- ID 和仓库没有重复收录。

自动检查不会执行插件入口代码，也不能证明代码没有恶意行为。

## 风险与更新等级

- `declarative`：无进程入口的内容包、主题或音色预设；权限不扩大时，打开商店会检查新版本，并在用户确认后更新。
- `unrestricted-process`：包含进程入口；以用户权限运行，只提示更新。
- `bundled`：由 DiceFrame 组织维护并随主程序发布。
- `approval-required`：新版本扩大权限或改变运行方式，暂停安装与更新。

收录表示插件符合索引规则，不构成安全保证或功能质量保证。
