# Contributing to the DiceFrame Plugin Registry

[中文](CONTRIBUTING.md) | English

## Repository requirements

A plugin must use its own public GitHub repository, with the plugin at the repository root. Pure content packs can skip the repository; see [No repository? Submit a content pack](#no-repository-submit-a-content-pack). The root must contain:

- `plugin.json`
- `README_CN.md` or `README.md`
- `LICENSE`, `LICENSE.md`, or `LICENSE.txt`
- `config.schema.json` when referenced by `plugin.json.config_schema`

Publish at least one non-draft, non-prerelease GitHub Release. The `plugin.json.version` at that Release must use a three-part version such as `1.0.0`.

Authors do not upload a plugin ZIP or calculate SHA-256. DiceFrame downloads the repository source snapshot at the immutable Git commit referenced by the Release.

## First submission

1. Open the [plugin submission form](https://github.com/diceframe/diceframe-plugins/issues/new/choose).
2. Enter the plugin ID and public repository URL.
3. Wait for the automated validation comment.
4. If validation fails, fix the plugin repository and reply `/recheck`.
5. Wait for a maintainer after validation passes.

Do not edit this repository's `plugins.json` or `plugin_details.json`. Pull request submissions are no longer used.

## Later releases

For an ordinary update:

1. Update `plugin.json.version`.
2. Commit the code and create a Git tag.
3. Publish a non-draft, non-prerelease GitHub Release.

Declarative plugins are checked and prompted when the user opens the plugin store, and updates are installed only after user confirmation, while permissions and runtime remain unchanged. Process plugins only notify users. Permission expansion, a change from declarative to process execution, repository transfer, or plugin ID change requires another review.

## No repository? Submit a content pack

Pure content packs without an executable entry point (adventure modules, worlds, rules, character cards) do not need their own GitHub repository:

1. Export the content pack from DiceFrame and rename the file to `.zip` (GitHub does not accept the `.dfplugin` extension).
2. Open [Submit content pack](https://github.com/diceframe/diceframe-plugins/issues/new?template=add-content-pack.yml), enter the plugin ID, author credit and license, and drag the `.zip` into the Package field.
3. Automation checks the package with DiceFrame's own validator: it unpacks the archive with the same rules as a client install and really loads adventures, references and locale files. If it fails, fix the package, upload it again by editing the issue, or reply `/recheck`.
4. A maintainer reviews the package once validation passes. On approval DiceFrame creates `module-<plugin id>` under the diceframe organization, pushes the package contents, publishes a `v<version>` Release and adds it to the registry.
5. When the package has no license file, one is generated from the license chosen in the form, crediting the author. A `LICENSE`, `LICENSE.md` or `LICENSE.txt` inside the package is kept as is.

To update, submit the same form again with a higher version. Only the original submitter or a maintainer can update a hosted pack. The store shows the author credit from the submission, and the trust level is community.

Authors without a GitHub account can ask a maintainer to submit on their behalf and name the author under Additional information.

### Maintainer setup

The approval step needs the repository secret `CONTENT_HOSTING_TOKEN`: a credential that can create public repositories, push contents and publish releases in the diceframe organization (an organization fine-grained token or a GitHub App installation token with read and write access to Administration and Contents). Without it `/approve` fails before creating anything.

If approval stops halfway (for example the registry push fails), reply `/approve` again: the repository, commit and Release recorded for this submission are reused instead of being published twice. A same-named repository that was not created for this submission is refused, never cleared or overwritten.

## Automated checks

Automation verifies that:

- the GitHub repository is public, active, and consistent with the plugin declaration;
- the latest Release, tag, fixed commit, and `plugin.json` are readable;
- plugin ID, version, type, permissions, and required fields are valid;
- documentation, license, and referenced configuration schema exist;
- file count and total size remain within installer limits;
- obvious secret files such as `.env`, private keys, and credential JSON files are absent;
- the ID and repository are not already registered.

Automation never executes the plugin entrypoint and cannot prove that executable code is harmless.

## Risk and update levels

- `declarative`: a content pack, theme, or voice preset without a process entrypoint; checked and prompted when the store is opened, with updates installed only after user confirmation if permissions do not expand.
- `unrestricted-process`: launches a process with the current user's operating-system privileges; updates are notification-only.
- `bundled`: maintained by the DiceFrame organization and released with the application.
- `approval-required`: a release expanded permissions or changed runtime behavior; installation and updates are paused.

Registry inclusion means that the listing rules were satisfied. It is not a security or quality warranty.

