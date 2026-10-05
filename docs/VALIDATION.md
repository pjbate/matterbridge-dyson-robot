# Validation and compatibility

## Provenance

- Upstream baseline: `b31b616` (version 1.10.17).
- Control logic: private development revision `1.10.17-rb05.11`.
- Public package: `1.10.17-rb05.12`, with sanitised documentation/fixtures and a dependency security refresh.
- This branch is not rebased onto the newer upstream RB05 implementation.

The runtime command logic is preserved. The public copy changes the experimental warning text and removes a household-specific code comment. Private diagnostics, captures, deployment files and credentials are not included.

## Physical evidence

One RB05 was used with a cloud MyDyson account and a completed room map.

An earlier patch revision completed a supervised single-room vacuum job initiated through Apple Home and returned to charging.

On 5 October 2026, a macOS Apple Home scene using a dedicated room tile on `rb05.11` passed fresh-state preflight, sent the single-room START packet and received a fresh running acknowledgement. The saved vacuum-and-mop job completed with robot-reported error code 0 and total operational time of 836 seconds. Dock return and subsequent dust collection/mop washing were observed. The owner confirmed the requested room clean worked.

The robot's saved cleaning rule was not rewritten. Exact physical pass counts were not independently measured. Final idle charging was not observed for this particular wet-cleaning run.

The public dependency refresh in `rb05.12` has not been retested on hardware. The Windows installation remains on its known-working `rb05.11` revision.

## Offline checks

Run `npm run build`, `npm run lint` and `npm run test:rb05`.

On 5 October 2026 the public source built and passed lint plus all 29 offline tests on Node 24.18.0. The development toolchain is pinned in package-lock.json. Matterbridge 3.10.12 is a development-only dependency, not bundled into the plugin, and uses Matter.js 0.17.9. The public package requires Matterbridge 3.10.12 or later; this host update is not installed on the live-tested Windows machine by packaging this fork.

The full locked dependency audit reported zero known vulnerabilities on that date. This is a point-in-time check, not a security certification. Updated versions include undici, ip-address, brace-expansion, js-yaml and the development-only Matterbridge host. Check current advisories before deploying.

Before publication on 6 October 2026, a fresh locked dependency installation again passed build, lint and all 29 offline tests, with zero known dependency audit findings. Fork-specific metadata and support links were finalised without changing command behaviour.

The suite covers:

- Synthetic native RB05 single-room START packet shape and the legacy Vis Nav packet shape.
- Fresh full state, rather than MQTT publication acknowledgement, as the success boundary.
- Position-only CURRENT-STATE messages not replacing or initialising full state.
- Room identity, map changes, removed rooms, conflicting selections and refusal to start busy/paused/offline/locked/faulted robots.
- Concurrent request rejection, cancellation by dock return and whole-home fallback rejection.
- Service Area selection staging, without hidden actuation.
- Real Matter On/Off command handling using fake asynchronous robot replies.
- Eight synthetic room endpoints, stable identities, startup without replay and momentary tile reset.
- Descriptive activity phases and preservation of legacy endpoint phase defaults.

The Matter test constructs a node but never starts or advertises it. The transport is fake and does not open a robot connection.

## Broader compatibility changes

Although the new room tiles and status phases are RB05-specific, this patch also changes shared code:

- Service Area SelectAreas stages a selection. Starting cleaning is a separate action, including on legacy room-capable models.
- Initial MQTT connection failures and non-abort reconnect failures are retried using the existing reconnect path and bounded backoff.
- State parsing and common command handling contain additional validation and cancellation paths.

Legacy packet format and endpoint defaults have offline coverage. Existing Eye, Heurist, Vis Nav and air-treatment devices have not been physically regression-tested with this fork.

## Boundaries

Do not claim support for all rooms, all saved cleaning modes, multiple current maps, every RB05 product variant, every Matter controller or every Node/Matterbridge version from these results.

Consumables, explicit wet-mode overrides, automatic recreation of room tiles without restart, behaviour during network interruption and interoperability with current upstream master remain unverified.

Safety guards reduce unintended actuation but do not certify physical behaviour. Initial use should be supervised.

## Privacy and packaging

Public tests use synthetic robot/map/zone identifiers and generic Room A to Room H labels. No real floor plan, serial number, account token, household inventory, private capture or device address is published.

The npm archive uses a file allowlist for compiled runtime code, the plugin schema and public guidance. npm also includes package metadata, README and licence. Offline tests and development helpers remain in source, not in the installable archive.

The package is marked private to prevent npm registry publication. This fork's CI uses offline checks only and has no deployment, live account, release-publication or npm-publication workflow.
