// Matterbridge plugin for Dyson robot vacuum and air treatment devices
// Copyright © 2025-2026 Alexander Thoukydides

import { BasicInformation } from 'matterbridge/matter/clusters';
import { RvcCleanMode360 } from './endpoint-360-behavior.js';
import {
    Dyson360CleaningStrategy,
    Dyson360EyePowerMode,
    Dyson360HeuristPowerMode,
    Dyson360TimelineEvent,
    Dyson360ZoneIcon
} from './dyson-360-types.js';
import {
    DysonDevice360Base,
    Dyson360PowerLevelMap,
    Dyson360CleanSummaryResult
} from './dyson-device-360-base.js';
import { DysonDevice360ZonesMixin } from './dyson-device-360-zones.js';
import {
    dysonRenderMap360Eye,
    dysonRenderMap360VisNav
} from './dyson-device-360-map.js';
import {
    Dyson360PersistentMapMetadata,
    Dyson360PersistentMapResponse,
    Dyson360SpotScrubMapMetadata,
    Dyson360SpotScrubMapZone
} from './dyson-360-cloud-types.js';
import { EndpointBase } from './endpoint-base.js';
import { EndpointRoomButton, roomButtonId } from './endpoint-room-button.js';
import { EntityName } from './config-types.js';
import { assertIsDefined } from './utils.js';
import { DysonMqttStatus } from './dyson-mqtt.js';
import { DysonMqttStatus360 } from './dyson-mqtt-360.js';

/* eslint-disable max-len */

// Common instructions for compatibility warning messages
const DYSON360_COMPATIBILITY_COMMON =
`If you are willing to help add support, please follow the detailed instructions in the project README.md for contributing opendyson logs and Proxyman API traces:
    https://github.com/thoukydides/matterbridge-dyson-robot#reporting-issues
    (expand the "Reporting Issues with Unsupported or Recently Released Products" section)`;

// Device-specific compatibility warning messages
const DYSON360_COMPATIBILITY_HEURIST =
`Support for Dyson 360 Heurist (RB02) is incomplete.

The device is currently treated similarly to a Dyson 360 Eye, with partial updates for known MQTT differences. There is a high likelihood of warnings, errors, or missing functionality. Mapping and zone cleaning are not currently supported.

${DYSON360_COMPATIBILITY_COMMON}`;

const DYSON360_COMPATIBILITY_SPOTSCRUB =
`Dyson Spot+Scrub Ai (RB05) support is experimental.

Basic status, battery, dock state and the Auto cleaning strategy are mapped from live MQTT state. Current-map rooms are exposed as Matter service areas and separate momentary room-clean tiles using saved Dyson rules. Single-room vacuuming and an Apple Home scene using a saved vacuum-and-mop rule have passed live tests on one RB05. Other devices, rooms and consumables remain unverified. Descriptive Matter phases are published, but controller display support varies. See docs/RB05.md for the scope and limitations of this experimental fork.

For guidance and sanitised reports about this experimental fork, see:
    https://github.com/pjbate/matterbridge-dyson-robot/blob/rb05-apple-home-room-controls/docs/RB05.md`;

/* eslint-enable max-len */

// A Dyson 360 Eye device
export class DysonDevice360Eye extends DysonDevice360Base {
    static readonly model = { type: 'N223', number: 'RB01', name: '360 Eye' };

    override getBatteryPartNumber = () => '968734-02';

    override getProductAppearance = () => ({
        finish:         BasicInformation.ProductFinish.Polished,
        primaryColor:   BasicInformation.Color.Nickel // (or Fuchsia for Japan limited edition)
    });

    override getPowerLevelMaps = (): Dyson360PowerLevelMap[] => [
        [Dyson360EyePowerMode.Quiet,        RvcCleanMode360.Quiet,      'Quiet'],
        [Dyson360EyePowerMode.Max,          RvcCleanMode360.MaxBoost,   'Max']
    ];

    override setPowerLevel = (powerLevel: Dyson360EyePowerMode) => this.mqtt.commandSetPowerMode(powerLevel);
    override getPowerLevel = () => this.mqtt.status.defaultVacuumPowerMode;

    // Retrieve details of a completed clean
    override async getCompletedClean(cleanId: string): Promise<Dyson360CleanSummaryResult> {
        const { logMapStyle } = this.config;
        if (!this.api || logMapStyle === 'Off') return 'Unavailable';

        // Retrieve details of the specified (or most recent) clean
        const history = await this.api.getCleaningHistory360();
        const clean = history.Entries.find(entry => entry.Clean === cleanId);
        if (!clean)                             return 'Not found';
        if (clean.IsInterim)                    return 'Not ready';
        const map = await this.api.getMapImage360(cleanId);

        // Render the Map
        return dysonRenderMap360Eye(this.log, logMapStyle, clean, map);
    }
}

// A Dyson 360 Heurist device
export class DysonDevice360Heurist extends DysonDevice360Base {
    static readonly model = { type: '276', number: 'RB02', name: '360 Heurist' };

    override getBatteryPartNumber = () => '970049-01';

    override getProductAppearance = () => ({
        finish:         BasicInformation.ProductFinish.Satin,
        primaryColor:   BasicInformation.Color.Blue
    });

    override getPowerLevelMaps = (): Dyson360PowerLevelMap[] => [
        [Dyson360HeuristPowerMode.Quiet,    RvcCleanMode360.Quiet,      'Quiet'],
        [Dyson360HeuristPowerMode.High,     RvcCleanMode360.High,       'High'],
        [Dyson360HeuristPowerMode.Max,      RvcCleanMode360.MaxBoost,   'Max']
    ];

    override setPowerLevel = (powerLevel: Dyson360HeuristPowerMode) => this.mqtt.commandSetPowerMode(powerLevel);
    override getPowerLevel = () => this.mqtt.status.defaultVacuumPowerMode;

    override get compatibilityWarning() { return DYSON360_COMPATIBILITY_HEURIST; }
}

// A Dyson 360 Vis Nav device
export class DysonDevice360VisNav extends DysonDevice360ZonesMixin(DysonDevice360Base) {
    static readonly model = { type: '277', number: 'RB03', name: '360 Vis Nav' };

    override getBatteryPartNumber = () => '967864-02';

    override getProductAppearance = () => ({
        finish:         BasicInformation.ProductFinish.Satin,
        primaryColor:   BasicInformation.Color.Blue
    });

    override getPowerLevelMaps = (): Dyson360PowerLevelMap[] => [
        [Dyson360CleaningStrategy.Auto,     RvcCleanMode360.Auto,       'Auto'],
        [Dyson360CleaningStrategy.Quick,    RvcCleanMode360.Quick,      'Quick'],
        [Dyson360CleaningStrategy.Quiet,    RvcCleanMode360.Quiet,      'Quiet'],
        [Dyson360CleaningStrategy.Boost,    RvcCleanMode360.MaxBoost,   'Boost']
    ];

    override setPowerLevel = (powerLevel: Dyson360CleaningStrategy) => this.mqtt.commandSetCleaningStrategy(powerLevel);
    override getPowerLevel = () => this.mqtt.status.defaultCleaningStrategy;

    // Retrieve details of a completed clean
    override async getCompletedClean(cleanId: string): Promise<Dyson360CleanSummaryResult> {
        const { logMapStyle } = this.config;
        if (!this.api || logMapStyle === 'Off') return 'Unavailable';

        // Retrieve details of the specified (or most recent) clean
        const history = await this.api.getCleanMaps360();
        const clean = history.find(entry => entry.cleanId === cleanId);
        if (!clean)                             return 'Not found';
        const interim = clean.cleanTimeline.at(-1)?.eventName !== Dyson360TimelineEvent.RunEnded;
        if (interim)                            return 'Not ready';
        let persistentMap: Dyson360PersistentMapResponse | undefined;
        if (clean.persistentMap) persistentMap = await this.api.getPersistentMap360(clean.persistentMap.id);

        // Render the map
        return dysonRenderMap360VisNav(this.log, logMapStyle, clean, persistentMap);
    }
}

// Map a Spot+Scrub room type/name to a Matter-compatible Dyson zone icon
function spotScrubZoneIcon(zone: Dyson360SpotScrubMapZone): Dyson360ZoneIcon {
    const key = `${zone.type ?? ''} ${zone.name}`.toLowerCase().replaceAll(/[^a-z]/g, '');
    const matches: [RegExp, Dyson360ZoneIcon][] = [
        [/frontbalcony|balcony/,                   Dyson360ZoneIcon.Balcony],
        [/guestbathroom|ensuite|bathroom/,         Dyson360ZoneIcon.Bathroom],
        [/mainbedroom|masterbedroom/,              Dyson360ZoneIcon.MainBedroom],
        [/kidsbedroom|guestbedroom|bedroom/,       Dyson360ZoneIcon.Bedroom],
        [/diningroom|dining/,                      Dyson360ZoneIcon.DiningRoom],
        [/hallway|hall/,                           Dyson360ZoneIcon.Hallway],
        [/kitchen/,                                Dyson360ZoneIcon.Kitchen],
        [/livingroom|lounge/,                      Dyson360ZoneIcon.LivingRoom],
        [/study/,                                  Dyson360ZoneIcon.Study],
        [/toilet/,                                 Dyson360ZoneIcon.Toilet],
        [/utilityroom|laundry/,                    Dyson360ZoneIcon.UtilityRoom],
        [/office|work/,                            Dyson360ZoneIcon.Work]
    ];
    return matches.find(([pattern]) => pattern.test(key))?.[1] ?? Dyson360ZoneIcon.Custom;
}

// Convert the RB05 v2 map response into the existing Service Area map model
export function normaliseSpotScrubMaps(
    maps: Dyson360SpotScrubMapMetadata[]
): Dyson360PersistentMapMetadata[] {
    const currentMaps = maps.filter(map => map.isCurrentMap);
    // Never expose or start a room from an inactive/unknown-current map.
    const selectedMaps = currentMaps;
    return selectedMaps.map(map => ({
        id:                             map.id,
        name:                           map.name,
        lastVisited:                    '',
        zonesDefinitionLastUpdatedDate: null,
        zones: map.zones.map(zone => ({
            area:   zone.area,
            icon:   spotScrubZoneIcon(zone),
            id:     zone.id,
            name:   zone.name
        })),
        zoneProperties: map.zones.map(zone => ({
            zones:          [zone.id],
            zoneBehaviours: {
                vacuumPowerMode:    null,
                cleaningStrategy:   zone.settings?.cleaningStrategy ?? Dyson360CleaningStrategy.Auto
            }
        }))
    }));
}

// A Dyson 360 Spot+Scrub device
export class DysonDevice360SpotScrub extends DysonDevice360ZonesMixin(DysonDevice360Base) {
    static readonly model = {
        type:       'RB05',
        number:     'RB05',
        name:       'Spot+Scrub Ai',
        cloudTypes: ['804']
    };

    readonly roomButtons: { mapId: string; zoneId: string; endpoint: EndpointRoomButton }[] = [];

    override async prepareEndpoints(): Promise<void> {
        await this.mapsReady;
        this.endpoint ??= this.makeEndpoint();
        if (this.roomButtons.length) return;
        for (const map of this.mapFromMatter.values()) {
            for (const zone of map.zones) {
                const id = roomButtonId(this.uniqueId, map.id, zone.id);
                const name = zone.name.trim() || 'Unnamed room';
                const endpoint = new EndpointRoomButton(this.log, this.config, {
                    id,
                    matterbridgeDeviceName: `${this.deviceName} Room ${name} ${id.slice(-8)}`,
                    basicInformation: {
                        ...this.endpoint.options.basicInformation,
                        uniqueId: id,
                        nodeLabel: name.substring(0, 32),
                        productName: 'Dyson Room Clean',
                        productLabel: `${name} room clean`.substring(0, 64)
                    }
                }, async () => {
                    assertIsDefined(this.commandHandlers);
                    await this.commandHandlers.startSingleRoom(`Room button ${name}`, {
                        mapId: map.id,
                        zoneId: zone.id,
                        resolveArea: async () => {
                            await this.updateMaps();
                            const areaId = this.findAreaId(map.id, zone.id);
                            if (areaId === null) throw new Error('Room is no longer on the current map');
                            return areaId;
                        }
                    });
                });
                this.roomButtons.push({ mapId: map.id, zoneId: zone.id, endpoint });
            }
        }
        this.log.info(`Prepared ${this.roomButtons.length} room-clean buttons using saved Dyson room rules`);
    }

    override getEndpoints(validatedNames: EntityName[]): EndpointBase[] {
        return [...super.getEndpoints(validatedNames), ...this.roomButtons.map(button => button.endpoint)];
    }

    override async updateClusterAttributes(status: DysonMqttStatus<DysonMqttStatus360>): Promise<void> {
        await super.updateClusterAttributes(status);
        await Promise.all(this.roomButtons.map(async ({ mapId, zoneId, endpoint }) => {
            const known = this.findAreaId(mapId, zoneId) !== null && status.persistentMapId === mapId;
            await endpoint.updateReachable(known && status.reachable && status.mqttState === 'initialised');
        }));
    }

    override async stop(): Promise<void> {
        for (const button of this.roomButtons) button.endpoint.stop();
        await super.stop();
    }

    override getBatteryPartNumber = () => '975571-01';

    override getProductAppearance = () => ({
        finish:         BasicInformation.ProductFinish.Matte,
        primaryColor:   BasicInformation.Color.Black
    });

    override getPowerLevelMaps = (): Dyson360PowerLevelMap[] => [
        [Dyson360CleaningStrategy.Auto, RvcCleanMode360.Auto, 'Auto']
    ];

    override setPowerLevel = (powerLevel: Dyson360CleaningStrategy) =>
        this.mqtt.commandSetCleaningStrategy(powerLevel);

    override getPowerLevel = () => this.mqtt.status.defaultCleaningStrategy;

    // RB05 uses the v2 map endpoint. Preserve its saved cleaning rules.
    // A Vis Nav programme cannot be assumed to select RB05 rooms correctly.
    override async getPersistentMapMetadata(): Promise<Dyson360PersistentMapMetadata[]> {
        if (!this.api) return [];
        const maps = await this.api.getPersistentMapMetadata360SpotScrub();
        return normaliseSpotScrubMaps(maps);
    }

    override get compatibilityWarning() { return DYSON360_COMPATIBILITY_SPOTSCRUB; }
}

// List of constructors for Dyson robot vacuum devices
export const DYSON_DEVICE_TYPES_360 = [
    DysonDevice360Eye,
    DysonDevice360Heurist,
    DysonDevice360VisNav,
    DysonDevice360SpotScrub
] as const;
