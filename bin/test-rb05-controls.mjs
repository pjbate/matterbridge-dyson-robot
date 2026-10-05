// Offline regression tests. No broker, account or physical device is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { AsyncEventEmitter } from '../dist/async-eventemitter.js';
import { Device360CommandHandlers } from '../dist/dyson-device-360-commands.js';
import { DysonMqtt360 } from '../dist/dyson-mqtt-360.js';
import { DysonMqtt } from '../dist/dyson-mqtt.js';
import { Dyson360State } from '../dist/dyson-360-types.js';
import { RvcRunMode360, ServiceAreaServer360 } from '../dist/endpoint-360-behavior.js';
import { checkers } from '../dist/ti/dyson-360-msg-types.js';
import { Dyson360FaultNextAction } from '../dist/dyson-360-types.js';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const programme = { persistentMapId: 'test-map', unorderedZones: ['zone-a'], orderedZones: [], zonesDefinitionLastUpdatedDate: null };
class FakeMqtt extends AsyncEventEmitter {
    isSpotScrub = true;
    fullStateRevision = 1;
    commands = [];
    deferStart = false;
    acceptRoom = true;
    status = { reachable: true, mqttState: 'initialised', state: Dyson360State.InactiveCharging, currentCleaningMode: 'global', persistentMapId: 'test-map' };
    assertRoomProgrammeSupported(selected) {
        DysonMqtt360.prototype.assertRoomProgrammeSupported.call(this, selected);
    }
    update(state, mode = this.status.currentCleaningMode) {
        Object.assign(this.status, { state, currentCleaningMode: mode });
        this.fullStateRevision++;
        this.emit('status');
    }
    async requestCurrentState() { this.update(this.status.state); }
    async commandAction(action, selected) {
        this.commands.push({ action, selected });
        if (action === 'START' && !this.deferStart) {
            this.update(Dyson360State.FullCleanRunning, selected && this.acceptRoom ? 'zoneConfigured' : 'global');
        } else if (action === 'ABORT') this.update(Dyson360State.Aborted);
    }
}
function fixture() {
    const mqtt = new FakeMqtt();
    const commands = new Map();
    const endpoint = { setCommandHandler360(name, handler) { commands.set(name, handler); } };
    const handler = new Device360CommandHandlers(log, mqtt, endpoint);
    handler.attachSelectAreasHandler(async areas => {
        assert.deepEqual(areas, [7]);
        return structuredClone(programme);
    }, () => 'Room A');
    return { mqtt, commands, handler };
}

const roomRequest = { mapId: 'test-map', zoneId: 'zone-a', async resolveArea() { return 7; } };

test('each of the eight room buttons starts only its own saved zone', async () => {
    for (const [index, name] of ['Room A', 'Room B', 'Room C', 'Room D', 'Room E', 'Room F', 'Room G', 'Room H'].entries()) {
        const { mqtt, handler } = fixture();
        const zoneId = `zone-${index}`;
        handler.selectedAreaIds = [999]; // Another tile's staged selection is not inherited.
        handler.makeCleaningProgramme = async areas => {
            assert.deepEqual(areas, [index + 1]);
            return { ...programme, unorderedZones: [zoneId] };
        };
        await handler.startSingleRoom(name, { mapId: 'test-map', zoneId, async resolveArea() { return index + 1; } });
        assert.deepEqual(handler.selectedAreaIds, [index + 1]);
        assert.deepEqual(mqtt.commands, [{ action: 'START', selected: { ...programme, unorderedZones: [zoneId] } }]);
    }
});

test('room buttons refuse offline, busy, paused, locked and attention-required states', async () => {
    for (const change of [
        { reachable: false }, { mqttState: 'disconnected' },
        { state: Dyson360State.FullCleanRunning }, { state: Dyson360State.FullCleanPaused },
        { childLock: true },
        { activeFaults: [{ faultCode: '568', nextActionRequired: Dyson360FaultNextAction.UserContinue }] }
    ]) {
        const { mqtt, handler } = fixture();
        Object.assign(mqtt.status, change);
        await assert.rejects(handler.startSingleRoom('Room A', roomRequest));
        assert.deepEqual(mqtt.commands, []);
    }
});

test('removed rooms and substituted zone identities fail without publishing', async () => {
    for (const replacement of [undefined, { ...programme, unorderedZones: ['replacement'] },
        { ...programme, unorderedZones: ['zone-a', 'zone-b'] }, { ...programme, persistentMapId: 'other-map' }]) {
        const { mqtt, handler } = fixture();
        handler.makeCleaningProgramme = async () => replacement;
        await assert.rejects(handler.startSingleRoom('Room A', roomRequest));
        assert.deepEqual(mqtt.commands, []);
    }
    const { mqtt, handler } = fixture();
    await assert.rejects(handler.startSingleRoom('removed', { ...roomRequest, async resolveArea() { throw new Error('Room removed'); } }));
    assert.deepEqual(mqtt.commands, []);
});

test('room readiness is checked again after asynchronous programme preparation', async () => {
    for (const change of [{ childLock: true },
        { activeFaults: [{ faultCode: '568', nextActionRequired: Dyson360FaultNextAction.UserContinue }] }]) {
        const { mqtt, handler } = fixture();
        handler.makeCleaningProgramme = async () => {
            Object.assign(mqtt.status, change);
            return programme;
        };
        await assert.rejects(handler.startSingleRoom('Room A', roomRequest));
        assert.deepEqual(mqtt.commands, []);
    }
});

test('different room tiles cannot overlap or secretly queue a second clean', async () => {
    const { mqtt, handler } = fixture();
    mqtt.deferStart = true;
    const first = handler.startSingleRoom('Room A', roomRequest);
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(handler.startSingleRoom('Room B', { ...roomRequest, zoneId: 'zone-b' }));
    assert.equal(mqtt.commands.length, 1);
    mqtt.update(Dyson360State.FullCleanRunning, 'zoneConfigured');
    await first;
    await assert.rejects(handler.startSingleRoom('Room B', { ...roomRequest, zoneId: 'zone-b' }));
    assert.equal(mqtt.commands.length, 1);
});

test('Send to Dock cancels a room button during map resolution without publishing START', async () => {
    const { mqtt, handler } = fixture();
    let release;
    const first = handler.startSingleRoom('Room A', { ...roomRequest, resolveArea: () => new Promise(resolve => { release = resolve; }) });
    const rejection = assert.rejects(first);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await handler.setTarget('Dock', 'GoHome'), true);
    release(7);
    await rejection;
    assert.deepEqual(mqtt.commands, []);
});

test('new room-button command path rejects a global fallback and compensates once', async () => {
    const { mqtt, handler } = fixture();
    mqtt.acceptRoom = false;
    await assert.rejects(handler.startSingleRoom('Room A', roomRequest));
    assert.deepEqual(mqtt.commands.map(command => command.action), ['START', 'ABORT']);
});

test('RB05 ABORTED, USER_CONTINUE and object positions validate', () => {
    assert.equal(checkers.Dyson360MsgCurrentState.strictValidate({
        msg: 'CURRENT-STATE', state: 'ABORTED', batteryChargeLevel: 99,
        activeFaults: [{ faultCode: '568', nextActionRequired: 'USER_CONTINUE' }]
    }), null);
    assert.equal(checkers.Dyson360MsgCurrentState.strictValidate({
        msg: 'CURRENT-STATE', globalPosition: [{ id: 1, x: 0, y: 0, angle: 0, update: 1 }]
    }), null);
    assert.equal(checkers.Dyson360MsgMapUploadStatus.strictValidate({
        msg: 'MAP-UPLOAD-STATUS', status: 'COMPLETE', persistentMapId: 'test-map'
    }), null);
});

test('position-only messages preserve full state and cannot initialise it', () => {
    const snapshot = { state: Dyson360State.InactiveCharging, batteryChargeLevel: 99, cleaningProgramme: programme };
    let initialised = 0;
    const receiver = { status: snapshot, fullStateRevision: 4, updateInitialised() { initialised++; } };
    DysonMqtt360.prototype.updateState.call(receiver, { msg: 'CURRENT-STATE', globalPosition: [{ id: 1, x: 0, y: 0, angle: 0, update: 1 }] });
    assert.equal(snapshot.state, Dyson360State.InactiveCharging);
    assert.equal(snapshot.cleaningProgramme, programme);
    assert.equal(receiver.fullStateRevision, 4);
    assert.equal(initialised, 0);
    DysonMqtt360.prototype.updateState.call(receiver, { msg: 'CURRENT-STATE', state: Dyson360State.Aborted });
    assert.equal(snapshot.state, Dyson360State.Aborted);
    assert.equal(snapshot.cleaningProgramme, undefined);
    assert.equal(receiver.fullStateRevision, 5);
    assert.equal(initialised, 1);
});

test('selecting Room A stages it without starting the robot', async () => {
    const { mqtt, commands, handler } = fixture();
    await commands.get('SelectAreas')([7]);
    assert.deepEqual(handler.selectedAreaIds, [7]);
    assert.deepEqual(mqtt.commands, []);
    await commands.get('ChangeRunMode')(RvcRunMode360.Cleaning);
    assert.deepEqual(mqtt.commands, [{ action: 'START', selected: programme }]);
});

test('broker acknowledgement alone is not success and overlapping Start is blocked', async () => {
    const { mqtt, commands, handler } = fixture();
    await commands.get('SelectAreas')([7]);
    mqtt.deferStart = true;
    let completed = false;
    const start = commands.get('ChangeRunMode')(RvcRunMode360.Cleaning).then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completed, false);
    assert.equal(await handler.setTarget('overlapping Start', 'Cleaning'), false);
    assert.equal(mqtt.commands.filter(command => command.action === 'START').length, 1);
    mqtt.update(Dyson360State.FullCleanRunning, 'zoneConfigured');
    await start;
    assert.equal(completed, true);
});

test('a global fallback is rejected and aborted, never reported as a room success', async () => {
    const { mqtt, commands } = fixture();
    await commands.get('SelectAreas')([7]);
    mqtt.acceptRoom = false;
    await assert.rejects(commands.get('ChangeRunMode')(RvcRunMode360.Cleaning), /did not accept room cleaning/);
    assert.deepEqual(mqtt.commands.map(command => command.action), ['START', 'ABORT']);
});

test('an external clean cannot acknowledge a staged Room A Start', async () => {
    const { mqtt, commands, handler } = fixture();
    await commands.get('SelectAreas')([7]);
    mqtt.update(Dyson360State.FullCleanRunning, 'zoneConfigured');
    assert.equal(await handler.setTarget('Room A Start', 'Cleaning'), false);
    assert.deepEqual(handler.selectedAreaIds, [7]);
    assert.deepEqual(mqtt.commands, []);
});

test('a native clean starting during room preparation is left untouched', async () => {
    const { mqtt, commands, handler } = fixture();
    await commands.get('SelectAreas')([7]);
    let release;
    handler.makeCleaningProgramme = () => new Promise(resolve => { release = resolve; });
    const start = handler.setTarget('Room A Start', 'Cleaning');
    await new Promise(resolve => setTimeout(resolve, 20));
    mqtt.update(Dyson360State.FullCleanRunning, 'global');
    release(programme);
    assert.equal(await start, false);
    assert.deepEqual(mqtt.commands, []);
    assert.deepEqual(handler.selectedAreaIds, [7]);
});

test('a superseded room Start cannot issue a second compensating abort', async () => {
    const { mqtt, commands, handler } = fixture();
    await commands.get('SelectAreas')([7]);
    mqtt.deferStart = true;
    const start = handler.setTarget('Room A Start', 'Cleaning');
    const rejectedStart = assert.rejects(start, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(mqtt.commands.map(command => command.action), ['START']);
    assert.equal(await handler.setTarget('Send to Dock', 'GoHome'), true);
    await rejectedStart;
    assert.deepEqual(mqtt.commands.map(command => command.action), ['START', 'ABORT']);
});

test('an invalid prepared RB05 programme is blocked before any actuation', async () => {
    const { mqtt, commands, handler } = fixture();
    await commands.get('SelectAreas')([7]);
    handler.makeCleaningProgramme = async () => ({ ...programme, persistentMapId: 'stale-map' });
    await assert.rejects(commands.get('ChangeRunMode')(RvcRunMode360.Cleaning), /current map/);
    assert.deepEqual(mqtt.commands, []);
});

function packetFixture(isSpotScrub = true) {
    const messages = [];
    const mqtt = {
        isSpotScrub,
        status: { persistentMapId: 'test-map' },
        mqttSubscribe: { commandTopic: 'RB05/test/command' },
        mqtt: { async publishAsync(topic, payload, options) { messages.push({ topic, payload: JSON.parse(payload), options }); } },
        logPayload() {},
        publish: DysonMqtt.prototype.publish,
        assertRoomProgrammeSupported: DysonMqtt360.prototype.assertRoomProgrammeSupported
    };
    return { mqtt, messages };
}

test('RB05 room START matches the captured native wire packet exactly', async () => {
    // Native RB05 single-room START shape, with synthetic identifiers.
    // No credentials, household names or private capture references are included.
    const captured = JSON.parse(await readFile(new URL('fixtures/rb05-single-room-start.json', import.meta.url), 'utf8'));
    const { mqtt, messages } = packetFixture();
    await DysonMqtt360.prototype.commandAction.call(mqtt, 'START', programme);
    assert.equal(messages.length, 1);
    const { time, ...packet } = messages[0].payload;
    assert.match(time, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(packet, captured);
    assert.deepEqual(messages[0].options, { qos: 1, retain: false });
    assert.equal(checkers.DysonSpotScrubStart.strictValidate(messages[0].payload), null);
});

test('invalid RB05 room programmes fail closed without publishing', async () => {
    for (const invalid of [
        {}, { ...programme, persistentMapId: 'stale-map' },
        { ...programme, unorderedZones: undefined }, { ...programme, unorderedZones: [] },
        { ...programme, unorderedZones: ['zone-a', 'zone-a'] },
        { ...programme, unorderedZones: [' '] },
        { ...programme, orderedZones: ['zone-a'] }
    ]) {
        const { mqtt, messages } = packetFixture();
        await assert.rejects(async () => DysonMqtt360.prototype.commandAction.call(mqtt, 'START', invalid), /current map/);
        assert.deepEqual(messages, []);
    }
});

test('the Vis Nav room START keeps its original wire format', async () => {
    const { mqtt, messages } = packetFixture(false);
    await DysonMqtt360.prototype.commandAction.call(mqtt, 'START', programme);
    const { time, ...packet } = messages[0].payload;
    assert.equal(typeof time, 'string');
    assert.deepEqual(packet, {
        msg: 'START', 'mode-reason': 'LAPP', fullCleanType: 'immediate',
        cleaningMode: 'zoneConfigured', cleaningProgramme: programme
    });
    assert.equal(checkers.Dyson360LegacyStart.strictValidate(messages[0].payload), null);
});

test('Send to Dock accepts and confirms the raw RB05 ABORTED state', async () => {
    const { mqtt, commands } = fixture();
    mqtt.update(Dyson360State.FullCleanRunning, 'zoneConfigured');
    await commands.get('GoHome')();
    assert.equal(mqtt.status.state, Dyson360State.Aborted);
    assert.deepEqual(mqtt.commands.map(command => command.action), ['ABORT']);
});

test('Send to Dock cancels a Start that is waiting for its fresh-state preflight', async () => {
    const { mqtt, handler } = fixture();
    let release;
    mqtt.requestCurrentState = () => new Promise(resolve => {
        release = () => { mqtt.update(mqtt.status.state); resolve(); };
    });
    const start = handler.setTarget('Start', 'Cleaning');
    assert.equal(await handler.setTarget('Send to Dock', 'GoHome'), true);
    release();
    assert.equal(await start, false);
    assert.deepEqual(mqtt.commands, []);
});

test('pending room validation blocks Start and can be cancelled by Send to Dock', async () => {
    const { mqtt, commands, handler } = fixture();
    let release;
    handler.attachSelectAreasHandler(() => new Promise(resolve => { release = resolve; }), () => 'Room A');
    const selection = commands.get('SelectAreas')([7]);
    assert.equal(await handler.setTarget('Start', 'Cleaning'), false);
    assert.equal(await handler.setTarget('Send to Dock', 'GoHome'), true);
    release(programme);
    await assert.rejects(selection);
    assert.equal(handler.selectedAreaIds, undefined);
    assert.deepEqual(mqtt.commands, []);
});

test('empty and unchanged Service Area selections are valid, without hidden starts', async () => {
    const calls = [];
    const service = {
        state: { supportedAreas: [{ areaId: 7, mapId: 1 }, { areaId: 8, mapId: 1 }], selectedAreas: [7] },
        agent: { get() { return { state: { device: { log, async executeCommand(...args) { calls.push(args); } } } }; } }
    };
    await ServiceAreaServer360.prototype.selectAreas.call(service, { newAreas: [7, 7] });
    assert.deepEqual(calls, []);
    const response = await ServiceAreaServer360.prototype.selectAreas.call(service, { newAreas: [] });
    assert.equal(response.status, 0);
    assert.deepEqual(calls, [['SelectAreas', []]]);
});
