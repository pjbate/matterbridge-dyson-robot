// Matterbridge plugin for Dyson robot vacuum and air treatment devices
// Copyright © 2025-2026 Alexander Thoukydides

import { AnsiLogger } from 'matterbridge/logger';
import { DysonMqtt360, DysonMqtt360Action } from './dyson-mqtt-360.js';
import { Endpoint360 } from './endpoint-360.js';
import { RvcCleanMode360, RvcRunMode360 } from './endpoint-360-behavior.js';
import { Dyson360CleaningMode, Dyson360CleaningProgramme, Dyson360FaultNextAction, Dyson360State } from './dyson-360-types.js';
import { CN, CV, RI } from './logger-options.js';
import { ChangeToModeError, RvcOperationalStateError, SelectAreaError } from './error-360.js';
import { MS } from './utils.js';

// Action to perform in each Dyson robot vacuum state
type StateAction =
    undefined                       // Invalid          => Immediate fail
  | true                            // No-op            => Immediate success
  | Lowercase<DysonMqtt360Action>   // Perform command  => Immediate success
  | DysonMqtt360Action;             // Perform command  => Wait for state change
const STATE_COLUMNS =                       ['Idle',   'Cleaning', 'ZoneClean', 'Mapping',  'Pause',    'Resume',   'GoHome'] as const;
const STATE_MAP: Record<Dyson360State, StateAction[]> = {
    [Dyson360State.Aborted]:                [true,      undefined,  undefined,  undefined,  undefined,  undefined,  true        ],
    [Dyson360State.MachineOff]:             [true,      undefined,  undefined,  undefined,  undefined,  undefined,  undefined   ],
    [Dyson360State.FaultCallHelpline]:      ['abort',   'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.FaultContactHelpline]:   ['abort',   'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.FaultCritical]:          ['abort',   'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.FaultGettingInfo]:       ['abort',   'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.FaultLost]:              ['abort',   'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.FaultOnDock]:            ['abort',   'START',    'START',    undefined,  undefined,  undefined,  true        ],
    [Dyson360State.FaultOnDockCharged]:     ['abort',   'START',    'START',    undefined,  undefined,  undefined,  true        ],
    [Dyson360State.FaultOnDockCharging]:    ['abort',   'START',    'START',    undefined,  undefined,  undefined,  true        ],
    [Dyson360State.FaultReplaceOnDock]:     ['abort',   'START',    'START',    undefined,  undefined,  undefined,  undefined   ],
    [Dyson360State.FaultReturnToDock]:      ['abort',   'START',    'START',    undefined,  undefined,  undefined,  undefined   ],
    [Dyson360State.FaultRunningDiagnostic]: ['abort',   'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.FaultUserRecoverable]:   ['abort',   'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.FullCleanAbandoned]:     [true,      'START',    undefined,  undefined,  undefined,  undefined,  true        ],
    [Dyson360State.FullCleanAborted]:       [true,      'START',    undefined,  undefined,  undefined,  undefined,  true        ],
    [Dyson360State.FullCleanCharging]:      ['ABORT',   true,       undefined,  undefined,  'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.FullCleanDiscovering]:   ['ABORT',   true,       undefined,  undefined,  'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.FullCleanFinished]:      [true,      'START',    undefined,  undefined,  undefined,  undefined,  true        ],
    [Dyson360State.FullCleanInitiated]:     ['ABORT',   true,       undefined,  undefined,  'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.FullCleanNeedsCharge]:   ['ABORT',   true,       undefined,  undefined,  'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.FullCleanPaused]:        ['ABORT',   true,       undefined,  undefined,  undefined,  'RESUME',   'ABORT'     ],
    [Dyson360State.FullCleanRunning]:       ['ABORT',   true,       undefined,  undefined,  'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.FullCleanTraversing]:    ['ABORT',   true,       undefined,  undefined,  'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.InactiveCharged]:        [true,      'START',    'START',    undefined,  undefined,  undefined,  true        ],
    [Dyson360State.InactiveCharging]:       [true,      'START',    'START',    undefined,  undefined,  undefined,  true        ],
    [Dyson360State.InactiveDischarging]:    [true,      'START',    'START',    undefined,  undefined,  undefined,  'ABORT'     ],
    [Dyson360State.MappingAborted]:         [true,      'START',    undefined,  undefined,  undefined,  undefined,  true        ],
    [Dyson360State.MappingCharging]:        ['ABORT',   'START',    undefined,  true,       'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.MappingFinished]:        [true,      'START',    undefined,  undefined,  undefined,  undefined,  true        ],
    [Dyson360State.MappingInitiated]:       ['ABORT',   'START',    undefined,  true,       'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.MappingNeedsCharge]:     ['ABORT',   'START',    undefined,  true,       'PAUSE',    undefined,  'ABORT'     ],
    [Dyson360State.MappingPaused]:          ['ABORT',   'START',    undefined,  true,       undefined,  'RESUME',   'ABORT'     ],
    [Dyson360State.MappingRunning]:         ['ABORT',   'START',    undefined,  true,       'PAUSE',    undefined,  'ABORT'     ]
};
type StateTarget = typeof STATE_COLUMNS[number];

// Timeout waiting for the next update
const UPDATE_TIMEOUT = 5 * MS; // 5 seconds

// A command to issue
export interface Device360Command {
    description:    string;
    command:        () => Promise<void>;
    condition:      () => boolean;
}

export interface SingleRoomRequest360 {
    mapId:          string;
    zoneId:         string;
    resolveArea:    () => Promise<number>;
}

// Attach command handlers to a Dyson robot vacuum device RVC endpoint
export class Device360CommandHandlers {

    // Abort previous operations that are still in progress
    abort?: AbortController;
    selectedAreaIds?: number[];
    makeCleaningProgramme?: (areaIds: number[]) => Promise<Dyson360CleaningProgramme>;
    private activeOperation?: symbol;
    private pendingStartOperation?: symbol;

    // Create a new command handler
    constructor (
        readonly log:       AnsiLogger,
        readonly mqtt:      DysonMqtt360,
        readonly endpoint:  Endpoint360
    ) {
        // Handle RVC Operational State Pause/Resume/GoHome commands
        const operationStateAction = async (target: StateTarget): Promise<void> => {
            if (!await this.setTarget(`${CN}RVC Operational State ${CV}${target}${RI}`, target)) {
                throw new RvcOperationalStateError.CommandInvalidInState();
            }
        };
        this.endpoint.setCommandHandler360('Pause',  () => operationStateAction('Pause'));
        this.endpoint.setCommandHandler360('Resume', () => operationStateAction('Resume'));
        this.endpoint.setCommandHandler360('GoHome', () => operationStateAction('GoHome'));

        // Handle RVC Run Mode cluster ChangeToMode commands
        this.endpoint.setCommandHandler360('ChangeRunMode', async newMode => {
            const target = RvcRunMode360[newMode] as keyof typeof RvcRunMode360;
            if (!await this.setTarget(`${CN}RVC Run Mode${RI} ChangeToMode ${formatEnumLog(RvcRunMode360, newMode)}`, target)) {
                throw new ChangeToModeError.InvalidInMode();
            }
        });
    }

    // Handle RVC Clean Mode cluster ChangeToMode commands
    attachCleanModeHandler(makePowerCommand: (cleanMode: RvcCleanMode360) => Device360Command): void {
        this.endpoint.setCommandHandler360('ChangeCleanMode', async newMode => {
            const { description, command, condition } = makePowerCommand(newMode);
            this.log.info(`${CN}RVC Clean Mode${RI} ChangeToMode ${formatEnumLog(RvcCleanMode360, newMode)} → ${CV}${description}${RI}`);
            await this.issueCommandAndWaitForUpdate(`set power mode ${description}`, command, condition);
        });
    }

    // Handle Service Area cluster SelectAreas commands
    attachSelectAreasHandler(
        makeCleaningProgramme:  (areaIds: number[]) => Promise<Dyson360CleaningProgramme>,
        makeAreaName:           (areaId: number) => string
    ): void {
        this.makeCleaningProgramme = makeCleaningProgramme;
        this.endpoint.setCommandHandler360('SelectAreas', async newAreas => {
            const areaNames = newAreas.map(areaId => makeAreaName(areaId));
            const description = `${CN}ServiceArea${RI} ${CV}SelectAreas${RI} [${areaNames.join(', ')}]`;
            // SelectAreas stages a selection. Only ChangeRunMode starts cleaning.
            // Validate the selection before accepting it, without any actuation.
            if (this.activeOperation || this.targetAction(newAreas.length ? 'ZoneClean' : 'Cleaning') !== 'START') {
                throw new SelectAreaError.InvalidInMode();
            }
            const operation = Symbol('SelectAreas');
            this.activeOperation = operation;
            try {
                if (newAreas.length) await makeCleaningProgramme(newAreas);
                if (this.activeOperation !== operation
                || this.targetAction(newAreas.length ? 'ZoneClean' : 'Cleaning') !== 'START') {
                    throw new SelectAreaError.InvalidInMode();
                }
                this.selectedAreaIds = [...newAreas];
                this.log.info(`${description} → selection staged; awaiting Start`);
            } finally {
                if (this.activeOperation === operation) this.activeOperation = undefined;
            }
        });
    }

    // Perform a command and wait for a status update
    async issueCommandAndWaitForUpdate (
        description:    string,
        command:        () => Promise<void>,
        condition:      () => boolean
    ): Promise<void> {
        try {
            // Make the operation abortable with a timeout
            this.abort?.abort();
            this.abort = new AbortController();
            const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(UPDATE_TIMEOUT)]);
            const revision = this.mqtt.fullStateRevision;

            // Publish the command
            await command();
            if (this.mqtt.isSpotScrub) await this.mqtt.requestCurrentState();

            // Wait for an update to satisfy the condition
            while (!condition() || this.mqtt.fullStateRevision <= revision) {
                await this.mqtt.onceAsync('status', signal);
            }
        } catch (cause) {
            // Identify the underlying error
            let err = cause instanceof Error ? cause : new Error(String(cause));
            while (err.name === 'AbortError' && err.cause instanceof Error) err = err.cause;

            // Map the error type to a description
            const errMap: Record<string, string> = {
                AbortError:     'Aborted',
                TimeoutError:   'Timed out'
            };
            const result = errMap[err.name] ?? 'Failed to';
            this.log.warn(`${result} ${description}`);
            throw err;
        }
    }

    // Lookup the action required for a particular target
    targetAction(target: StateTarget): StateAction {
        const column = STATE_COLUMNS.indexOf(target);
        const { reachable, mqttState } = this.mqtt.status;
        const state = this.mqtt.status.state as Dyson360State | undefined;
        if (!reachable || mqttState !== 'initialised' || state === undefined) return undefined;
        return STATE_MAP[state][column];
    };

    // A room button owns its selection and START as one operation. It does not
    // race a separate SelectAreas call or use another tile's staged selection.
    async startSingleRoom(description: string, room: SingleRoomRequest360): Promise<void> {
        if (!this.mqtt.isSpotScrub || !await this.setTarget(description, 'Cleaning', room)) {
            throw new RvcOperationalStateError.CommandInvalidInState('Room clean cannot start in the current state');
        }
    }

    private canStartRoom(): boolean {
        const idle = [Dyson360State.InactiveCharged, Dyson360State.InactiveCharging,
                      Dyson360State.InactiveDischarging].includes(this.mqtt.status.state);
        const needsAttention = this.mqtt.status.activeFaults?.some(fault =>
            fault.nextActionRequired !== Dyson360FaultNextAction.LogOnly);
        return idle && !this.mqtt.status.childLock && !needsAttention;
    }

    // Attempt to set a target state, returning false if not allowed
    async setTarget(description: string, target: StateTarget, room?: SingleRoomRequest360): Promise<boolean> {
        // Refuse overlapping starts instead of publishing from stale state.
        // Stop/dock can still interrupt an outstanding start immediately.
        const stopping = target === 'GoHome' || target === 'Idle';
        if (this.activeOperation && !stopping) return false;
        const cancelsPendingStart = stopping && this.pendingStartOperation !== undefined;
        const operation = Symbol(target);
        this.activeOperation = operation;
        if (stopping) this.abort?.abort();
        try {
            // RB05 does not push full state. Confirm it before START/RESUME.
            if (this.mqtt.isSpotScrub && (target === 'Cleaning' || target === 'Resume')) {
                const revision = this.mqtt.fullStateRevision;
                const signal = AbortSignal.timeout(UPDATE_TIMEOUT);
                const started = Date.now();
                let publishedMs: number | undefined;
                const diagnostic = () => JSON.stringify({
                    before: revision, after: this.mqtt.fullStateRevision,
                    elapsedMs: Date.now() - started, publishedMs,
                    fullStateAgeMs: this.mqtt.lastFullStateAt ? Date.now() - this.mqtt.lastFullStateAt : null,
                    reachable: this.mqtt.status.reachable, mqttState: this.mqtt.status.mqttState
                });
                try {
                    await this.mqtt.requestCurrentState();
                    publishedMs = Date.now() - started;
                    while (this.mqtt.fullStateRevision <= revision) await this.mqtt.onceAsync('status', signal);
                    this.log.info(`RB05 fresh-state check passed: ${diagnostic()}`);
                } catch (err) {
                    // Primitive counters only. Never include packets, account
                    // details, connection options or private map/room IDs.
                    this.log.error(`RB05 fresh-state check failed: ${diagnostic()}`);
                    throw err;
                }
            }
            if (this.activeOperation !== operation) return false;
            if (room) {
                // Buttons are starts, never hidden resume/replace/queue commands.
                if (!this.canStartRoom()) return false;
            }
            const areaIds = room ? [await room.resolveArea()] : this.selectedAreaIds ?? [];
            if (this.activeOperation !== operation) return false;
            // Check whether the target is allowed or already satisfied
            let action = this.targetAction(target);
            // START may be on the wire while the last full state still says
            // docked. Send an explicit stop instead of treating Dock as a no-op.
            if (action === true && cancelsPendingStart) action = 'ABORT';
            if (action === undefined) {
                this.log.info(`${description} → not allowed in current state`);
                return false;
            } else if (action === true) {
                // A clean started elsewhere cannot acknowledge a staged room
                // request. Refuse it without interrupting the existing clean.
                if (target === 'Cleaning' && areaIds.length) {
                    this.log.info(`${description} → selected-room Start not allowed during an existing clean`);
                    return false;
                }
                this.log.info(`${description} → no action required`);
                return true;
            }

            // Publish a command to change the robot state
            this.log.info(`${description} → ${CV}${action}${RI}`);
            const command = action.toUpperCase() as Uppercase<typeof action>;
            const programme = command === 'START' && target === 'Cleaning' && areaIds.length
            ? await this.makeCleaningProgramme?.(areaIds) : undefined;
            if (this.activeOperation !== operation) return false;
            // A map refresh can await the cloud. Do not overwrite a native
            // clean that started while the room programme was being prepared.
            if (command === 'START' && this.targetAction(target) !== action) {
                this.log.info(`${description} → robot state changed while preparing Start`);
                return false;
            }
            if (room && !this.canStartRoom()) return false;
            if (command === 'START' && areaIds.length && !programme) throw new Error('Selected room programme unavailable');
            if (room && (programme?.persistentMapId !== room.mapId
            || programme.unorderedZones?.length !== 1 || programme.unorderedZones[0] !== room.zoneId)) {
                throw new Error('Room identity changed while preparing Start');
            }
            if (programme) this.mqtt.assertRoomProgrammeSupported(programme);
            if (room) this.selectedAreaIds = [...areaIds];
            const isTargetAchieved = (action: StateAction): boolean =>
                action === true || action === action?.toLowerCase();
            try {
                await this.issueCommandAndWaitForUpdate(
                    `perform action ${target}`,
                    async () => {
                        if (command === 'START') {
                            this.pendingStartOperation = operation;
                            await this.mqtt.commandAction('START', programme);
                        } else await this.mqtt.commandAction(command);
                    },
                    () => {
                        if (programme && this.mqtt.status.currentCleaningMode === Dyson360CleaningMode.Global
                        && this.targetAction('Cleaning') === true) throw new Error('Robot did not accept room cleaning');
                        return isTargetAchieved(this.targetAction(target))
                        && (!programme || this.mqtt.status.currentCleaningMode === Dyson360CleaningMode.ZoneConfigured);
                    }
                );
            } catch (err) {
                // A rejected/ambiguous room START must never continue globally.
                // A superseded room Start no longer owns the robot. Its late
                // cleanup must not abort a newer Stop, Dock or Start command.
                if (programme && this.activeOperation === operation) {
                    await this.mqtt.commandAction('ABORT');
                    await this.mqtt.requestCurrentState();
                }
                throw err;
            }
            return true;
        } finally {
            if (this.pendingStartOperation === operation) this.pendingStartOperation = undefined;
            if (this.activeOperation === operation) this.activeOperation = undefined;
        }
    };
}

// Format an enum value for logging
function formatEnumLog<T extends Record<string, number | string>>(
    enumMap:    T,
    value:      T[keyof T] extends number ? T[keyof T] : never
): string {
    const label = enumMap[value as keyof T];
    return `${CV}${label}${RI} (${CV}${value}${RI})`;
}
