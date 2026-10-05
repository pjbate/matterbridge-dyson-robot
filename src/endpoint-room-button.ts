// Matterbridge plugin for Dyson robot vacuum and air treatment devices
// Copyright © 2025-2026 Alexander Thoukydides

import { bridgedNode, onOffPlugInUnit } from 'matterbridge';
import { Behavior } from 'matterbridge/matter';
import { Status, StatusResponseError } from 'matterbridge/matter/types';
import { OnOffServer } from 'matterbridge/matter/behaviors';
import { AnsiLogger } from 'matterbridge/logger';
import { Config } from './config-types.js';
import { EndpointBase, EndpointOptionsBase } from './endpoint-base.js';
import { createHash } from 'node:crypto';

// Names/order can change without repurposing an already-paired room tile.
export function roomButtonId(robotId: string, mapId: string, zoneId: string): string {
    const hash = createHash('sha256').update(JSON.stringify([robotId, mapId, zoneId])).digest('hex');
    return `dyson-room-${hash}`.substring(0, 32);
}

export class RoomButtonAction {
    private pending = false;
    private resetTimer?: NodeJS.Timeout;

    constructor(
        readonly start: () => Promise<void>,
        readonly reset: () => Promise<void>,
        readonly log: AnsiLogger
    ) {}

    async press(): Promise<void> {
        if (this.pending) throw new Error('Room button request already pending');
        this.pending = true;
        try { await this.start(); } finally { this.pending = false; }
    }

    // The pulse is a request acknowledgement, never a cleaning/progress state.
    pulse(): void {
        clearTimeout(this.resetTimer);
        this.resetTimer = setTimeout(() => {
            void this.reset().catch(() => { this.log.warn('Unable to reset room button display'); });
        }, 1000);
        this.resetTimer.unref();
    }

    stop(): void { clearTimeout(this.resetTimer); }
}

export class RoomButtonBehavior extends Behavior {
    static override readonly id = 'dyson-room-button';
    declare state: RoomButtonBehavior.State;
}
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace RoomButtonBehavior {
    export class State { action!: RoomButtonAction; }
}

// A remotely invokable On/Off tile, not a GenericSwitch physical input.
export class RoomButtonOnOffServer extends OnOffServer {
    override async initialize(): Promise<void> {
        await super.initialize();
        // A restored display value is never a request to replay a clean.
        this.state.onOff = false;
    }

    override async on(): Promise<void> {
        const { action } = this.agent.get(RoomButtonBehavior).state;
        let stage = 'start';
        try {
            await action.press();
            stage = 'display';
            this.state.onOff = true;
            stage = 'reset';
            action.pulse();
        } catch (err) {
            // Keep the original rejection observable. Never log MQTT packets,
            // credentials or map identifiers from an arbitrary error payload.
            const kind = err instanceof Error ? err.name : 'UnknownError';
            const reason = err instanceof Error ? err.message
                .replace(/https?:\/\/\S+|[A-Za-z0-9_-]{24,}/g, '[redacted]').substring(0, 160) : 'Unknown rejection';
            (this.endpoint as EndpointRoomButton).log.error(`Room button ${stage} rejected (${kind}): ${reason}`);
            this.state.onOff = false;
            throw new StatusResponseError('Room clean was not started', Status.InvalidInState);
        }
    }

    // Off only resets the request tile. It must never abort the robot or another room.
    override off(): void { this.state.onOff = false; }
    override async toggle(): Promise<void> {
        if (this.state.onOff) this.off();
        else await this.on();
    }
}

export class EndpointRoomButton extends EndpointBase {
    readonly action: RoomButtonAction;

    constructor(log: AnsiLogger, config: Config, options: EndpointOptionsBase, start: () => Promise<void>) {
        super(log, config, options, [onOffPlugInUnit, bridgedNode]);
        this.action = new RoomButtonAction(start, async () => {
            await this.updateAttribute(RoomButtonOnOffServer, 'onOff', false, this.log);
        }, log);
        this.behaviors.require(RoomButtonBehavior, { action: this.action });
        this.behaviors.require(RoomButtonOnOffServer, { onOff: false });
        this.createDefaultGroupsClusterServer();
        this.createDefaultScenesManagementClusterServer();
    }

    stop(): void { this.action.stop(); }
}
