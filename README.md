# DiceFrame 插件中心

中文 | [English](README_EN.md)

本仓库是 DiceFrame 社区插件的公开索引。插件源码由作者在各自 GitHub 仓库中维护。

## 投稿

插件作者在 [Issues](https://github.com/diceframe/diceframe-plugins/issues/new/choose) 中选择"添加插件"，只需填写插件 ID 和公开仓库地址。

机器人会读取最新 GitHub Release，验证 `plugin.json`、版本、仓库结构、权限声明、README、LICENSE 和明显的秘密文件。验证通过后，维护者审核并决定是否收录：

```text
/approve
```

通过后，你的插件会出现在商店索引中，用户即可在 DiceFrame 的插件商店搜索到并安装。插件后续发布新版本时，商店会自动同步更新（见下方更新策略）。

拒绝时维护者回复：

```text
/reject 原因
```

未通过会说明原因，按提示调整后可以重新提交。

完整要求见 [贡献指南](CONTRIBUTING.md)。

**没有自己的仓库？** 冒险模组、世界、规则、角色卡这类纯内容包，可以用「投稿内容包」表单直接上传从 DiceFrame 导出的 `.zip`。审核通过后由 DiceFrame 在 diceframe 组织下代为托管，见[贡献指南](CONTRIBUTING.md#没有自己的仓库投稿内容包)。

## 更新策略

- 声明型 `content-pack`、`theme`、`voice-pack`：权限和运行方式不变时，只检测并提示新版本，由用户确认后更新。
- 包含 Python、Node、EXE 或其他进程入口的插件：只提示新版本，不静默更新。
- 新版本增加权限、改变运行方式、转移仓库或更换插件 ID：暂停更新并要求重新审核。
- 内置插件（如 QQ / NapCat）：随 DiceFrame 主程序发布，不从商店重复安装。

索引仓库每天自动同步一次插件信息（北京时间约 11:17），用于商店展示。DiceFrame 客户端安装或检查更新时会直接解析作者仓库最新 Release，因此定时任务停止也不会阻断插件更新；即使同步缓存尚未刷新，你也能立即拿到作者发布的最新版本。

## 安全说明

自动检查通过只代表格式和机器可验证条件合格，不代表插件代码绝对安全。包含可执行代码的第三方插件会以明确的高风险等级展示；收录也不等于 DiceFrame 为其安全性背书。

## 开发文档

- [DiceFrame 主项目](https://github.com/diceframe/diceframe)
- [插件开发指南](https://github.com/diceframe/diceframe-content/blob/main/docs/zh/plugin-development.md)
- [插件索引与审核规则](https://github.com/diceframe/diceframe-content/blob/main/docs/zh/plugin-registry.md)
- [Bot Bridge 核心](https://github.com/diceframe/diceframe-content/blob/main/docs/zh/bot-bridge-core.md)
- [发布音色预设](https://github.com/diceframe/diceframe-content/blob/main/docs/zh/voice-pack-publishing.md)

本索引仓库使用 MIT License。各插件使用其自身仓库声明的许可证。
