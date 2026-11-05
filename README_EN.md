# DiceFrame Plugin Registry

[中文](README.md) | English

This repository is the public index for DiceFrame community plugins. Plugin source code remains in repositories maintained by each author.

## Submitting a plugin

Open [Issues](https://github.com/diceframe/diceframe-plugins/issues/new/choose), choose “Add plugin”, and provide only the plugin ID and public repository URL. No fork, JSON editing, SHA-256 calculation, or uploaded package is required.

Automation checks the latest GitHub Release, `plugin.json`, version, repository structure, declared permissions, documentation, license, and obvious secret files. After validation, a maintainer reviews and decides whether to include your plugin:

```text
/approve
```

Once approved, your plugin appears in the store index, and users can find and install it from the DiceFrame plugin store. When you publish new versions, the store syncs the update automatically (see Update policy below).

To reject a submission:

```text
/reject reason
```

If your plugin is not accepted, the reason is given so you can adjust and resubmit.

See the [contribution guide](CONTRIBUTING_EN.md) for the complete requirements.

**No repository?** Pure content packs such as adventure modules, worlds, rules and character cards can be submitted with the “Submit content pack” form by uploading the `.zip` exported from DiceFrame. After approval DiceFrame hosts it under the diceframe organization; see the [contribution guide](CONTRIBUTING_EN.md#no-repository-submit-a-content-pack).

## Update policy

- Declarative `content-pack`, `theme`, and `voice-pack` plugins are checked for new versions and notified; updates are installed only after user confirmation, while their permissions and runtime model remain unchanged.
- Plugins that launch Python, Node, executables, or another process only notify users about updates; they are never silently updated.
- A permission increase, runtime change, repository transfer, or plugin ID change pauses updates and requires another review.
- Bundled plugins such as QQ / NapCat ship with DiceFrame and are not installed again from the store.

The registry syncs once per day (around 11:17 Beijing time / 03:17 UTC) for store display. DiceFrame resolves the latest repository Release when installing or checking for updates, so scheduled workflow suspension does not stop updates; even if the sync cache has not refreshed yet, you can still get the latest version an author publishes immediately.

## Security

Passing automated validation means only that machine-verifiable format and policy checks passed. It does not prove that code is safe. Third-party executable plugins are displayed with an explicit high-risk classification, and registry inclusion is not a security warranty from DiceFrame.

## Development documentation

- [DiceFrame](https://github.com/diceframe/diceframe)
- [Plugin development guide](https://github.com/diceframe/diceframe-content/blob/main/docs/en/plugin-development.md)
- [Registry and review policy](https://github.com/diceframe/diceframe-content/blob/main/docs/en/plugin-registry.md)
- [Bot Bridge core](https://github.com/diceframe/diceframe-content/blob/main/docs/en/bot-bridge-core.md)
- [Publishing voice presets](https://github.com/diceframe/diceframe-content/blob/main/docs/en/voice-pack-publishing.md)

This registry is licensed under the MIT License. Each plugin uses the license declared in its own repository.

