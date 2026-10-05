// Offline room/status tests. The Matter server is never started or advertised.
import '@matter/nodejs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Environment, Logger, LogLevel } from '@matter/general';
import { AccessControl } from '@matter/protocol';
import { Endpoint, ServerNode, VendorId } from 'matterbridge/matter';
import { AggregatorEndpoint } from '@matter/node/endpoints';
import { RvcOperationalState } from 'matterbridge/matter/clusters';
import { BridgedDeviceBasicInformationServer } from 'matterbridge/matter/behaviors';
import { roomButtonId, RoomButtonAction, RoomButtonBehavior, RoomButtonOnOffServer } from '../dist/endpoint-room-button.js';
import { DysonDevice360SpotScrub, normaliseSpotScrubMaps } from '../dist/dyson-device-360.js';
import { RB05_PHASES, mapSpotScrubActivity } from '../dist/dyson-rb05-status.js';
import { Dyson360State } from '../dist/dyson-360-types.js';
import { createRvcOperationalStateClusterServer } from '../dist/endpoint-360-rvc.js';
import { Endpoint360 } from '../dist/endpoint-360.js';
import { RvcCleanMode360 } from '../dist/endpoint-360-behavior.js';
import { rvcOperationalStateBehavior } from '../dist/endpoint-360-rvc.js';
import { AsyncEventEmitter } from '../dist/async-eventemitter.js';
import { Device360CommandHandlers } from '../dist/dyson-device-360-commands.js';
import { DysonMqtt360 } from '../dist/dyson-mqtt-360.js';
import { DysonMqtt } from '../dist/dyson-mqtt.js';
import { dysonMqttParse } from '../dist/dyson-mqtt-parse.js';
import { DysonMqttFilter } from '../dist/dyson-mqtt-filter.js';
import { checkers } from '../dist/ti/dyson-360-msg-types.js';

const testErrors = [];
const log = { info() {}, warn() {}, debug() {}, error(message) { testErrors.push(message); } };
const config = { enableServerRvc: true, debugFeatures: [] };
const names = ['Room A', 'Room B', 'Room C', 'Room D', 'Room E', 'Room F', 'Room G', 'Room H'];
const map = { id: 'test-map', name: 'Test Map', zones: names.map((name, index) => ({ id: `zone-${index}`, name })) };
const op = RvcOperationalState.OperationalState;
Logger.level = LogLevel.ERROR;

test('room identity is stable across names/order and distinct across robot/map/zone', () => {
    const identity = roomButtonId('robot', 'map', 'zone');
    assert.equal(identity, roomButtonId('robot', 'map', 'zone'));
    assert.equal(identity.length, 32);
    assert.equal(new Set([identity, roomButtonId('other-robot', 'map', 'zone'),
        roomButtonId('robot', 'other-map', 'zone'), roomButtonId('robot', 'map', 'other-zone')]).size, 4);
});

test('inactive or unknown-current maps are not exposed as room buttons', () => {
    const current = { ...map, isCurrentMap: true };
    const old = { ...map, id: 'old-map', isCurrentMap: false };
    assert.deepEqual(normaliseSpotScrubMaps([old]), []);
    assert.deepEqual(normaliseSpotScrubMaps([{ ...map }]), []);
    assert.deepEqual(normaliseSpotScrubMaps([old, current]).map(item => item.id), ['test-map']);
});

test('descriptive phases use reported activity and honest generic fallbacks', () => {
    const cases = [
        [{}, op.Stopped, 'Idle', op.Stopped],
        [{ fullCleanAction: 'LOCATING' }, op.Running, 'Finding location', op.Running],
        [{ fullCleanAction: 'VACUUMING' }, op.Running, 'Vacuuming', op.Running],
        [{ fullCleanAction: 'VACUUMING_AND_MOPPING' }, op.Running, 'Vacuuming and mopping', op.Running],
        [{ fullCleanAction: 'MOPPING' }, op.Running, 'Mopping', op.Running],
        [{ fullCleanAction: 'FUTURE_ACTION', cleaningState: 'NOT_CLEANING' }, op.Running, 'Cleaning', op.Running],
        [{ state: Dyson360State.FullCleanDiscovering }, op.Running, 'Finding location', op.Running],
        [{ state: Dyson360State.FullCleanTraversing }, op.Running, 'Travelling to room', op.Running],
        [{}, op.Paused, 'Paused', op.Paused],
        [{}, op.SeekingCharger, 'Returning to dock', op.SeekingCharger],
        [{ fullCleanAction: 'VACUUMING' }, op.Charging, 'Charging', op.Charging],
        [{}, op.Docked, 'Docked', op.Docked],
        [{ dockState: 'COLLECTING_DUST' }, op.Charging, 'Emptying dust bin', op.EmptyingDustBin],
        [{ dockState: 'WASHING_MOP' }, op.Charging, 'Washing mop', op.CleaningMop],
        [{ dockState: 'DRYING_MOP' }, op.Charging, 'Drying mop', op.Charging],
        [{ dockState: 'WASHING_MOP' }, op.Error, 'Needs attention', op.Error],
        [{ dockState: 'WASHING_MOP' }, op.Paused, 'Paused', op.Paused]
    ];
    for (const [status, state, label, expectedState] of cases) {
        const actual = mapSpotScrubActivity(status, state);
        assert.equal(RB05_PHASES[actual.currentPhase], label);
        assert.equal(actual.operationalState, expectedState);
    }
    assert.ok(RB05_PHASES.length <= 32);
    assert.ok(RB05_PHASES.every(label => Buffer.byteLength(label) <= 64));
});

test('RVC phase attributes are valid while legacy devices remain unchanged', () => {
    let state;
    const endpoint = { behaviors: { require(type, attributes) { state = attributes; } } };
    createRvcOperationalStateClusterServer(endpoint);
    assert.equal(state.phaseList, null);
    assert.equal(state.currentPhase, null);
    assert.equal(state.operationalStateList.some(item => item.operationalStateId === op.CleaningMop), false);
    createRvcOperationalStateClusterServer(endpoint, [...RB05_PHASES]);
    assert.deepEqual(state.phaseList, RB05_PHASES);
    assert.equal(state.currentPhase, 0);
    assert.equal(state.operationalStateList.some(item => item.operationalStateId === op.CleaningMop), true);
});

test('button action rejects overlapping presses, resets after success and cancels timers on shutdown', async () => {
    let release, starts = 0, resets = 0;
    const action = new RoomButtonAction(() => { starts++; return new Promise(resolve => { release = resolve; }); },
        async () => { resets++; }, log);
    const first = action.press();
    await assert.rejects(action.press());
    assert.equal(starts, 1);
    release();
    await first;
    action.pulse();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(resets, 1);
    action.pulse();
    action.stop();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(resets, 1);
});

test('actual Matter bridge constructs eight independently named, momentary room tiles', async () => {
    const requests = [];
    const robot = {
        mapsReady: Promise.resolve(), endpoint: undefined, roomButtons: [],
        uniqueId: 'test-robot', deviceName: 'Test Robot', mapFromMatter: new Map([[1, map]]), log, config,
        makeEndpoint: () => ({ options: { basicInformation: {
            uniqueId: 'test-robot', nodeLabel: 'Test Robot', productId: 0x8000,
            productName: 'Robot', vendorId: VendorId(0xfff1), vendorName: 'Test'
        } } }),
        commandHandlers: { async startSingleRoom(name, room) { requests.push({ name, room }); } }
    };
    await DysonDevice360SpotScrub.prototype.prepareEndpoints.call(robot);
    await DysonDevice360SpotScrub.prototype.prepareEndpoints.call(robot);
    assert.equal(robot.roomButtons.length, 8);
    assert.equal(requests.length, 0); // Startup and registration never clean.

    const scratch = await mkdtemp(path.join(os.tmpdir(), 'offline-rb05-matter-offline-'));
    const environment = new Environment('offline-rb05-room-test', Environment.default);
    environment.vars.set('path.root', scratch);
    environment.vars.set('runtime.signals', false);
    environment.vars.set('runtime.exitcode', false);
    let server;
    try {
        server = await ServerNode.create({ id: 'offline-rb05-room-test', environment,
            basicInformation: { vendorId: VendorId(0xfff1), vendorName: 'Test', productId: 0x8000, productName: 'Offline room test' } });
        const aggregator = new Endpoint(AggregatorEndpoint, { id: 'rooms' });
        await server.add(aggregator);
        const rvc = new Endpoint360(log, { ...config, enableServerRvc: false }, {
            id: 'robot-status', matterbridgeDeviceName: 'Offline Test Robot Status',
            basicInformation: robot.endpoint.options.basicInformation,
            powerSource: { batteryPartNumber: '975571-01' },
            rvcCleanMode: { labels: [[RvcCleanMode360.Auto, 'Auto']], simpleModeTags: false },
            supportsMaps: true, statusPhases: [...RB05_PHASES]
        });
        await aggregator.add(rvc);
        assert.deepEqual(rvc.stateOf(rvcOperationalStateBehavior).phaseList, RB05_PHASES);
        for (const [index, label] of RB05_PHASES.entries()) {
            const state = label === 'Washing mop' ? op.CleaningMop : label === 'Emptying dust bin' ? op.EmptyingDustBin : op.Running;
            await rvc.updateRvcOperationalState({ isActive: true, operationalState: state,
                operationalError: { errorStateId: 0 }, currentPhase: index });
            assert.equal(rvc.stateOf(rvcOperationalStateBehavior).currentPhase, index);
            assert.equal(rvc.stateOf(rvcOperationalStateBehavior).operationalState, state);
        }
        for (const [index, { endpoint }] of robot.roomButtons.entries()) {
            assert.equal(endpoint.mode, undefined); // Never an extra RVC server.
            endpoint.behaviors.require(RoomButtonOnOffServer, { onOff: true }); // Simulate a stale restored display.
            await aggregator.add(endpoint);
            assert.equal(endpoint.stateOf(BridgedDeviceBasicInformationServer).nodeLabel, names[index]);
            assert.equal(endpoint.stateOf(RoomButtonOnOffServer).onOff, false);
            assert.ok(endpoint.behaviors.typeFor(RoomButtonBehavior));
        }
        const endpoint = robot.roomButtons[3].endpoint;
        // Local .act() bypasses remote field-access rules. Exercise the same
        // online-command state rules, without starting a server or using LAN.
        try {
            await endpoint.act(agent => endpoint.agentFor({
                ...agent.context, offline: false, command: true,
                authorityAt: () => AccessControl.Authority.Granted
            }).get(RoomButtonOnOffServer).on());
        } catch {
            assert.fail(testErrors.at(-1) ?? 'Online room command rejected');
        }
        assert.equal(requests.length, 1);
        requests.length = 0;
        await endpoint.act(agent => agent.get(RoomButtonOnOffServer).on());
        assert.equal(requests.length, 1);
        assert.equal(requests[0].room.zoneId, 'zone-3');
        assert.equal(requests[0].room.mapId, 'test-map');
        assert.equal(endpoint.stateOf(RoomButtonOnOffServer).onOff, true);
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.equal(endpoint.stateOf(RoomButtonOnOffServer).onOff, false);
        await endpoint.act(agent => agent.get(RoomButtonOnOffServer).off());
        assert.equal(requests.length, 1); // Off never sends Stop/Abort/Start.

        // Cross the real online Matter command boundary and the real command
        // handler, with asynchronous parsed/filtered robot replies. The fake
        // transport never opens a socket or publishes to a physical robot.
        const wirePackets = [];
        const receiver = new AsyncEventEmitter();
        Object.assign(receiver, {
            isSpotScrub: true, fullStateRevision: 1,
            status: { reachable: true, mqttState: 'initialised', state: Dyson360State.InactiveCharging,
                currentCleaningMode: 'global', persistentMapId: 'test-map' },
            log, logPayload() {},
            mqttSubscribe: { commandTopic: 'RB05/test/command' },
            publish: DysonMqtt.prototype.publish,
            requestCurrentState: DysonMqtt360.prototype.requestCurrentState,
            commandAction: DysonMqtt360.prototype.commandAction,
            assertRoomProgrammeSupported: DysonMqtt360.prototype.assertRoomProgrammeSupported,
            updateInitialised: DysonMqtt.prototype.updateInitialised
        });
        const filter = new DysonMqttFilter(log);
        let running = false;
        receiver.mqtt = { async publishAsync(topic, payload) {
            const packet = JSON.parse(payload);
            if (packet.msg === 'START') {
                assert.ok(receiver.fullStateRevision > 1, 'START must follow a fresh full state');
                running = true;
                wirePackets.push(packet);
            } else assert.equal(packet.msg, 'REQUEST-CURRENT-STATE');
            setTimeout(() => {
                const message = dysonMqttParse(log, { prefix: 'Dyson360Msg', checkers }, 'RB05/test/status', true,
                    Buffer.from(JSON.stringify({ msg: 'CURRENT-STATE', time: new Date().toISOString(),
                        state: running ? Dyson360State.FullCleanRunning : Dyson360State.InactiveCharging,
                        'current-cleaning-mode': running ? 'zoneConfigured' : 'global',
                        'persistent-map-id': 'test-map', 'battery-charge-level': 100 })));
                if (!filter.filter(message)) {
                    DysonMqtt360.prototype.updateState.call(receiver, message);
                    receiver.emit('status');
                }
            }, 15);
        } };
        robot.updateMaps = async () => {};
        robot.findAreaId = (mapId, zoneId) => mapId === 'test-map' && zoneId === 'zone-3' ? 7 : null;
        robot.commandHandlers = new Device360CommandHandlers(log, receiver, rvc);
        robot.commandHandlers.attachSelectAreasHandler(async areas => {
            assert.deepEqual(areas, [7]);
            return { persistentMapId: 'test-map', unorderedZones: ['zone-3'], orderedZones: [], zonesDefinitionLastUpdatedDate: null };
        }, () => 'Room A');
        await endpoint.act(agent => endpoint.agentFor({ ...agent.context, offline: false, command: true,
            authorityAt: () => AccessControl.Authority.Granted }).get(RoomButtonOnOffServer).on());
        assert.equal(wirePackets.length, 1);
        assert.deepEqual(wirePackets[0].cleaningProgramme.unorderedZones, ['zone-3']);
        assert.equal(receiver.status.currentCleaningMode, 'zoneConfigured');
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.equal(endpoint.stateOf(RoomButtonOnOffServer).onOff, false);

        robot.commandHandlers.startSingleRoom = async () => { throw new Error('Not ready'); };
        await assert.rejects(endpoint.act(agent => agent.get(RoomButtonOnOffServer).on()));
        assert.equal(endpoint.stateOf(RoomButtonOnOffServer).onOff, false);
    } finally {
        for (const { endpoint } of robot.roomButtons) endpoint.stop();
        await server?.close();
        await environment.close();
    }
});
