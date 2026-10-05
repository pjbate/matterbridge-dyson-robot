# Contributing to the experimental RB05 fork

This is a small experimental reproduction branch based on upstream 1.10.17. It is not a replacement for the official project's ongoing development.

For a report about this fork, include the experimental version, Node/Matterbridge versions, intended action, reported robot state and whether the physical target room was correct. Explain whether you used the dedicated room tile or the main RVC Start command.

Do not attach raw account configuration, tokens, serial numbers, MQTT credentials, floor plans, private map IDs or unredacted API/MQTT captures. Use synthetic identifiers and remove household names from examples.

Changes should preserve fail-closed room selection, fresh-state acknowledgement, cancellation, no hidden starts during selection/startup and no replay of stored tile values. Add an offline regression test. Hardware tests must be explicitly authorised by the device owner.

Do not enable live account CI or automatic npm publication. Run the build, lint and offline tests before sharing a patch.

The original project [does not accept pull requests](https://github.com/thoukydides/.github/blob/master/CONTRIBUTING.md). Share relevant evidence with a link on [its existing RB05 issue](https://github.com/thoukydides/matterbridge-dyson-robot/issues/46) rather than opening a PR that its automation will close.
