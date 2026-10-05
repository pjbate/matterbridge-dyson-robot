# Experimental RB05 Apple Home room controls: rb05.12

This is a fork of matterbridge-dyson-robot 1.10.17, not an official upstream or Dyson release. The upstream author's ISC licence and credit are preserved.

This is an AI-assisted experimental patch, with supervised evidence from one robot and offline regression coverage. It is not a certified compatibility guarantee.

## Included

- RB05 cloud product recognition, v2 current-map rooms and native-format room START messages.
- Individually named momentary Matter room tiles that use existing MyDyson rules.
- Fresh-state and room identity checks, concurrent-action rejection, cancellation and no intentional whole-home fallback for a room request.
- Additional RB05 activity and dock-maintenance statuses.
- Synthetic offline regression tests and an offline-only CI workflow.
- A dependency refresh for inherited npm security advisories. The installable archive excludes private probes, logs, captures and deployment scripts.
- A pinned development toolchain and a Matterbridge 3.10.12 minimum for the public package, without modifying the live-tested Windows installation.

## Evidence

Single-room vacuuming was physically verified on an earlier patch. A dedicated room tile invoked by a macOS Apple Home scene completed a saved vacuum-and-mop job on rb05.11 and returned to the dock for maintenance.

The public rb05.12 dependency refresh is offline-tested, not physically retested. Other devices and households are unverified. This older baseline has not been rebased onto newer upstream RB05 work.

## Install

Read the README and docs/RB05.md. Download the plugin tgz and SHA-256 file, back up the current plugin and Matterbridge pairing/configuration data, stop Matterbridge, install the downloaded package using the existing account/npm prefix and restart.

The package retains the original plugin name and replaces that installed package. It is not published to npm. For room scenes use one room tile set to Turn On, not the main robot Start action. Tile Off does not stop cleaning.

Use only for supervised experimental testing until the physical behaviour in your own home has been confirmed.
