// Matterbridge plugin for Dyson robot vacuum and air treatment devices
// Copyright © 2025-2026 Alexander Thoukydides

import { RvcOperationalState } from 'matterbridge/matter/clusters';
import { Dyson360State } from './dyson-360-types.js';
import { DysonMqttStatus360 } from './dyson-mqtt-360.js';

// Phase labels are descriptive telemetry, not invented room progress or an ETA.
// Apple Home decides whether and where to display these standard Matter fields.
export const RB05_PHASES = [
    'Idle', 'Finding location', 'Vacuuming', 'Vacuuming and mopping', 'Mopping',
    'Cleaning', 'Travelling to room', 'Paused', 'Returning to dock', 'Charging',
    'Docked', 'Needs attention', 'Emptying dust bin', 'Washing mop', 'Drying mop'
] as const;
type Phase = typeof RB05_PHASES[number];

export function mapSpotScrubActivity(
    status: DysonMqttStatus360,
    operationalState: RvcOperationalState.OperationalState
): { currentPhase: number; operationalState: RvcOperationalState.OperationalState } {
    let phase: Phase;
    if (operationalState === RvcOperationalState.OperationalState.Error) phase = 'Needs attention';
    else if (operationalState === RvcOperationalState.OperationalState.Paused) phase = 'Paused';
    else if (status.dockState === 'WASHING_MOP') {
        phase = 'Washing mop';
        operationalState = RvcOperationalState.OperationalState.CleaningMop;
    } else if (status.dockState === 'COLLECTING_DUST') {
        phase = 'Emptying dust bin';
        operationalState = RvcOperationalState.OperationalState.EmptyingDustBin;
    } else if (status.dockState === 'DRYING_MOP') phase = 'Drying mop';
    else if (operationalState === RvcOperationalState.OperationalState.SeekingCharger) phase = 'Returning to dock';
    else if (operationalState === RvcOperationalState.OperationalState.Charging) phase = 'Charging';
    else if (operationalState === RvcOperationalState.OperationalState.Docked) phase = 'Docked';
    else if (operationalState === RvcOperationalState.OperationalState.Running) {
        switch (status.fullCleanAction) {
        case 'LOCATING':               phase = 'Finding location'; break;
        case 'VACUUMING':              phase = 'Vacuuming'; break;
        case 'VACUUMING_AND_MOPPING':   phase = 'Vacuuming and mopping'; break;
        case 'MOPPING':                phase = 'Mopping'; break;
        default:
            phase = status.state === Dyson360State.FullCleanDiscovering ? 'Finding location'
                  : status.state === Dyson360State.FullCleanTraversing ? 'Travelling to room' : 'Cleaning';
        }
    } else phase = 'Idle';
    return { currentPhase: RB05_PHASES.indexOf(phase), operationalState };
}
