// Matterbridge plugin for Dyson robot vacuum and air treatment devices
// Copyright © 2025-2026 Alexander Thoukydides

import { AnsiLogger } from 'matterbridge/logger';
import { Config } from './config-types.js';
import { DysonMqtt, DysonMqttConfig } from './dyson-mqtt.js';
import {
    checkers as dysonMsgCheckers360,
    TypeMap as DysonMsgMap360
} from './ti/dyson-360-msg-types.js';
import { assertIsDefined, tryListener } from './utils.js';
import {
    Dyson360MsgCurrentState,
    Dyson360MsgStateChange
} from './dyson-360-msg-types.js';
import {
    Dyson360CleaningMode,
    Dyson360CleaningProgramme,
    Dyson360CleaningStrategy,
    Dyson360CleaningType,
    Dyson360PowerMode,
    Dyson360State
} from './dyson-360-types.js';
import { DysonModeReason } from './dyson-types.js';
import { DeviceConfigMqtt } from './dyson-mqtt-client-live.js';
import NodePersist from 'node-persist';

// Configuration of a Dyson MQTT client for robot vacuums
const DYSON_MQTT_CONFIG_360: DysonMqttConfig<DysonMsgMap360> = {
    topics: {
        command:    '@/@/command',
        subscribe: ['@/@/status'],
        other:     ['@/initialconnection/credentials',
                    '@/initialconnection/status']
    },
    messages: {
        prefix:     'Dyson360Msg',
        checkers:   dysonMsgCheckers360
    }
};

// Dyson robot vacuum status
export type DysonMqttStatus360 = Omit<Dyson360MsgCurrentState, 'msg' | 'time' | 'state'> & { state: Dyson360State };

// Dyson robot vacuum supported commands
export type DysonMqtt360Action = 'START' | 'PAUSE' | 'RESUME' | 'ABORT';

// Dyson MQTT client for robot vacuums
export class DysonMqtt360 extends DysonMqtt<DysonMsgMap360, DysonMqttStatus360> {

    // A full RB05 state is only sent in response to an explicit request.
    statePoll?: NodeJS.Timeout;
    fullStateRevision = 0;
    lastFullStateAt = 0;

    get isSpotScrub(): boolean { return this.deviceConfig.rootTopic === 'RB05'; }

    // Construct a new MQTT client
    constructor(log: AnsiLogger, config: Config, persist: NodePersist.LocalStorage, device: DeviceConfigMqtt) {
        super(log, config, persist, device, DYSON_MQTT_CONFIG_360);

        // Handle MQTT events
        this.on('subscribed', tryListener(this, async () => {
            clearInterval(this.statePoll);
            if (this.isSpotScrub) {
                this.statePoll = setInterval(() => {
                    if (this.status.reachable) void this.requestCurrentState().catch((err: unknown) => this.emit('error', err));
                }, 15_000);
                this.statePoll.unref();
            }
            await this.requestCurrentState();
        })
        ).on('message', tryListener(this, msg => {
            // Update the robot vacuum state from the received messages
            switch (msg.msg) {
            case 'STATE-CHANGE':
                msg = this.convertStateChange(msg);
                // (fallthrough)
            case 'CURRENT-STATE':
                this.updateState(msg);
                break;
            }
        }));
    }

    // Convert a STATE-CHANGE message to CURRENT-STATE format
    convertStateChange(msg: Dyson360MsgStateChange): Dyson360MsgCurrentState {
        const {
            // Discard unmapped or replaced fields
            msg: _, endOfClean,
            oldActiveFaults, oldOutOfBoxState, oldstate, oldZoneId,
            // Capture renamed or modified fields
            newActiveFaults, newOutOfBoxState, newstate, newZoneId,
            // Everything else is copied unchanged
            ...rest
        } = msg;
        return {
            msg: 'CURRENT-STATE',
            ...rest,
            activeFaults:       newActiveFaults ?? rest.activeFaults,
            outOfBoxState:      newOutOfBoxState,
            state:              newstate,
            zoneId:             newZoneId,
            batteryChargeLevel: rest.batteryChargeLevel ?? 0 // (may be omitted on power on)
        };
    }

    // Update the robot vacuum state from a received message
    updateState(msg: Dyson360MsgCurrentState): void {
        // A position-only message must neither initialise nor erase full state.
        if (msg.state === undefined) {
            if (msg.globalPosition !== undefined) this.status.globalPosition = msg.globalPosition;
            return;
        }
        // Clear fields from the state that might have disappeared
        const DELETE_KEYS  = [
            'activeFaults',         'cleanDuration',            'cleanId',
            'cleaningProgramme',    'faults',                   'globalPosition',
            'persistentMapId',      'sessionId',                'traverseTargetId',
            'zoneId',               'zonesDefinitionVersion',   'zoneStatus',
            'fullCleanAction',      'dockState',                'cleaningState'
        ] as const satisfies (keyof Dyson360MsgCurrentState)[];
        for (const key of DELETE_KEYS) this.status[key] = undefined;

        // Copy status fields from the message to the state
        const { msg: _msg, time, ...status } = msg;
        Object.assign(this.status, status);
        this.fullStateRevision++;
        this.lastFullStateAt = Date.now();

        // State is fully initialised after the first message has been received
        this.updateInitialised();
    }

    requestCurrentState(): Promise<void> { return this.publish('REQUEST-CURRENT-STATE', {}); }

    override async stop(): Promise<void> {
        clearInterval(this.statePoll);
        this.statePoll = undefined;
        await super.stop();
    }

    // Publish a robot vacuum command to perform an action
    assertRoomProgrammeSupported(cleaningProgramme?: Dyson360CleaningProgramme): void {
        if (!this.isSpotScrub) return;
        const { persistentMapId, unorderedZones, orderedZones } = cleaningProgramme ?? {};
        // Never turn a missing, stale or malformed room request into global START.
        if (!persistentMapId || persistentMapId !== this.status.persistentMapId
        || !unorderedZones?.length || orderedZones?.length
        || unorderedZones.some(zone => typeof zone !== 'string' || !zone.trim())
        || new Set(unorderedZones).size !== unorderedZones.length) {
            throw new Error('RB05 room programme must contain unique rooms from the current map');
        }
    }

    commandAction(msg: DysonMqtt360Action): Promise<void>;
    commandAction(msg: 'START', cleaningProgramme?: Dyson360CleaningProgramme): Promise<void>;
    commandAction(msg: DysonMqtt360Action, cleaningProgramme?: Dyson360CleaningProgramme): Promise<void> {
        switch (msg) {
        case 'START':
            if (cleaningProgramme) this.assertRoomProgrammeSupported(cleaningProgramme);
            if (this.isSpotScrub && cleaningProgramme) {
                const { unorderedZones } = cleaningProgramme;
                assertIsDefined(unorderedZones);
                // Use the exact native RB05 packet. Extra Vis Nav fields caused
                // a live room request to fall back to whole-home cleaning.
                return this.publish('START', {
                    'mode-reason': DysonModeReason.RemoteApp,
                    cleaningMode:  Dyson360CleaningMode.ZoneConfigured,
                    cleaningProgramme: {
                        persistentMapId: cleaningProgramme.persistentMapId,
                        unorderedZones:  [...unorderedZones]
                    }
                });
            }
            return this.publish('START', cleaningProgramme ? {
                'mode-reason':      DysonModeReason.LocalApp,
                fullCleanType:      Dyson360CleaningType.Immediate,
                cleaningMode:       Dyson360CleaningMode.ZoneConfigured,
                cleaningProgramme
            } : {
                'mode-reason':      DysonModeReason.LocalApp,
                fullCleanType:      Dyson360CleaningType.Immediate,
                cleaningMode:       this.status.defaultCleaningMode     && Dyson360CleaningMode.Global,
                cleaningStrategy:   this.status.defaultCleaningStrategy && Dyson360CleaningStrategy.Auto
            });
        case 'PAUSE':
        case 'RESUME':
        case 'ABORT':
            return this.publish(msg, {
                'mode-reason':  DysonModeReason.LocalApp
            });
        }
    }

    // Publish a robot vacuum command to set the default power level (360 Eye)
    commandSetPowerMode(defaultVacuumPowerMode: Dyson360PowerMode): Promise<void> {
        return this.publish('STATE-SET', {
            'mode-reason':  DysonModeReason.LocalApp,
            data:           { defaultVacuumPowerMode }
        });
    }

    // Publish a robot vacuum command to set the default power level (360 Vis Nav)
    commandSetCleaningStrategy(defaultCleaningStrategy: Dyson360CleaningStrategy): Promise<void> {
        return this.publish('STATE-SET', {
            'mode-reason':  DysonModeReason.LocalApp,
            defaults:       { defaultCleaningStrategy }
        });
    }
}
