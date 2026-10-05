# Experimental RB05 room controls for Matterbridge

An experimental fork of [matterbridge-dyson-robot](https://github.com/thoukydides/matterbridge-dyson-robot), originally written by Alexander Thoukydides and distributed under the [ISC licence](LICENSE).

This branch packages a working Dyson Spot+Scrub Ai (RB05) integration with individually named room-clean tiles for Apple Home. It is not an official Dyson product, a certified Matter accessory or an official upstream release.

The patch was developed with AI assistance. A sanitised native-command fixture and supervised tests on one robot informed the implementation; they do not establish compatibility with other hardware.

## Choose the right version

This fork is based on upstream **1.10.17**, commit `b31b616`. Upstream has since added further RB05 work. Check the [official project](https://github.com/thoukydides/matterbridge-dyson-robot) first: this branch has not been rebased onto its newer code.

The public package is **1.10.17-rb05.12**. Its control logic comes from the live-tested `rb05.11` patch. The public build removes private development material and refreshes dependencies with reported security fixes. Those dependency changes have not been physically retested on a robot.

## What it adds

- One momentary On/Off tile for each room on the robot's current Dyson map, named from the Dyson app.
- Room starts using the robot's existing saved cleaning rules. A tile does not override vacuum power, water level, cleaning type or pass counts.
- Fresh-state checks, room identity validation and rejection of busy, paused, locked, offline or attention-required states.
- Standard Matter activity phases including locating, vacuuming, mopping, travelling, dock return and dock maintenance.

An accepted tile request turns back off after about one second. **Off does not stop the robot.** Use the main robot's Pause or Return to dock control.

## Apple Home and Siri

Pair both the Matterbridge bridge, which contains the room tiles, and the standalone robot when `enableServerRvc` is enabled. Then create a scene with exactly one room tile set to **Turn On**.

For example, a scene called “Clean Room A” can be invoked with “Hey Siri, Clean Room A”. If you name a scene “Mop Room A”, first configure that room's wet-cleaning rule in MyDyson. The scene name itself does not request a different cleaning mode.

For room scenes, do not use the main robot's Start action. With no room selected, that action can start a whole-home clean.

Apple Home chooses how to render Matter status. It may show generic wording such as “Travelling” or “Cleaning Mop Pad” instead of this plugin's more descriptive phase labels.

## Install and recover

Read [the installation, safety and rollback guide](docs/RB05.md) before installing. Download the `.tgz` package from [this fork's GitHub Releases page](https://github.com/pjbate/matterbridge-dyson-robot/releases), verify its SHA-256 and install it with the same account and npm prefix as Matterbridge.

This package deliberately retains the original plugin name for compatibility. Do not install the official and experimental versions simultaneously. A normal plugin update may replace this fork.

There is no npm registry release from this fork. Registry publication is disabled with `private: true`.

## Evidence and limitations

On one RB05, a single-room vacuum command was physically verified on an earlier patch revision. A macOS Apple Home scene using a dedicated room tile on `rb05.11` then completed a saved vacuum-and-mop job, returned to the dock and began dock maintenance.

The public build has offline regression tests for commands, packet shape, safety checks, room identity, Matter command handling and activity phases. See [validation and compatibility notes](docs/VALIDATION.md).

Other households, all room rules, other robot models, consumables, network interruption recovery and the newer upstream branch have not been live-tested. This is a supervised experimental release, not a general compatibility guarantee.

## Development and credit

```sh
npm ci --ignore-scripts
npm run build
npm run lint
npm run test:rb05
```

Use a Node version supported by `package.json`. The public package requires Matterbridge 3.10.12 or later and has an exact 3.10.12 development dependency for offline checks. Offline tests use fake transport and synthetic identifiers. They do not start or advertise a Matter server and do not send commands to a physical robot.

The original author's copyright, licence and funding information are retained. Upstream [does not accept pull requests](https://github.com/thoukydides/.github/blob/master/CONTRIBUTING.md), so relevant findings should be shared with a link on [the existing RB05 issue](https://github.com/thoukydides/matterbridge-dyson-robot/issues/46).

See [contribution guidance](CONTRIBUTING.md) for sanitised reports about this experimental fork.
