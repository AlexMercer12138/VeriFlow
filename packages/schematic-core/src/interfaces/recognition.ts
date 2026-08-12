import type { WidthValue } from '@veriflow/hdl-core/model';

import { compareCodeUnits } from '../archDesign/ordering';
import {
    type InterfaceMemberDirection,
    type InterfaceProtocol,
    type InterfaceProtocolCatalog,
    type InterfaceProtocolCatalogEntry,
    type InterfaceRecognitionDiagnostic,
    type InterfaceRecognitionPort,
    type InterfaceRecognitionResult,
    type RecognizedInterface,
    type RecognizedInterfaceMember,
    type RecognizedInterfaceRole,
} from './model';

type SuffixMatch = Readonly<{
    suffix: string;
    member: string;
    direction: InterfaceMemberDirection;
}>;

type CandidateMember = Readonly<{
    member: string;
    port: string;
    direction: InterfaceMemberDirection;
    portDirection: InterfaceRecognitionPort['direction'];
    width: WidthValue;
    declarationOrder: number;
}>;

type Candidate = {
    entry: InterfaceProtocolCatalogEntry;
    key: string;
    normalizedKey: string;
    firstOrder: number;
    members: Map<string, CandidateMember>;
    duplicatePorts: string[];
};

type QualifiedCandidate = Readonly<{
    candidate: Candidate;
    signatureSpecificity: number;
}>;

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
    if (value === null || typeof value !== 'object' || visited.has(value)) return value;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
        deepFreeze((value as Record<PropertyKey, unknown>)[key], visited);
    }
    return Object.freeze(value);
}

function cloneWidth(width: WidthValue): WidthValue {
    if (width.kind === 'known') return { kind: 'known', bits: width.bits };
    if (width.kind === 'symbolic') {
        return { kind: 'symbolic', expression: width.expression };
    }
    return { kind: 'unknown' };
}

function suffixMatches(protocol: InterfaceProtocol): readonly SuffixMatch[] {
    const matches: SuffixMatch[] = [];
    for (const member of protocol.members) {
        const suffixes = [member.name, ...(member.aliases ?? [])];
        for (const suffix of suffixes) {
            matches.push({
                suffix: `${protocol.separator}${suffix}`.toLowerCase(),
                member: member.name,
                direction: member.direction,
            });
        }
    }
    matches.sort((left, right) =>
        right.suffix.length - left.suffix.length
        || compareCodeUnits(left.suffix, right.suffix)
        || compareCodeUnits(left.member, right.member));
    return matches;
}

function matchedPort(
    portName: string,
    matches: readonly SuffixMatch[]
): Readonly<{ key: string; match: SuffixMatch }> | undefined {
    const normalizedPort = portName.toLowerCase();
    for (const match of matches) {
        if (!normalizedPort.endsWith(match.suffix)) continue;
        const keyLength = portName.length - match.suffix.length;
        if (keyLength <= 0) continue;
        return { key: portName.slice(0, keyLength), match };
    }
    return undefined;
}

function signatureSpecificity(candidate: Candidate): number {
    const memberNames = new Set(candidate.members.keys());
    let specificity = 0;
    for (const group of candidate.entry.protocol.recognitionGroups) {
        let complete = true;
        for (const name of group) {
            if (!memberNames.has(name.toLowerCase())) {
                complete = false;
                break;
            }
        }
        if (complete && group.length > specificity) specificity = group.length;
    }
    return specificity;
}

function compareCandidates(left: QualifiedCandidate, right: QualifiedCandidate): number {
    return right.signatureSpecificity - left.signatureSpecificity
        || right.candidate.members.size - left.candidate.members.size
        || right.candidate.entry.protocol.priority - left.candidate.entry.protocol.priority;
}

function roleFor(candidate: Candidate): RecognizedInterfaceRole {
    let masterEvidence = 0;
    let slaveEvidence = 0;
    for (const member of candidate.members.values()) {
        if (member.portDirection === 'inout') continue;
        const master = member.direction === 'master-to-slave'
            ? member.portDirection === 'output'
            : member.portDirection === 'input';
        if (master) masterEvidence += 1;
        else slaveEvidence += 1;
    }
    if (masterEvidence === slaveEvidence) return 'unknown';
    return masterEvidence > slaveEvidence ? 'master' : 'slave';
}

function recognized(candidate: Candidate): RecognizedInterface {
    const role = roleFor(candidate);
    const members: RecognizedInterfaceMember[] = [...candidate.members.values()]
        .sort((left, right) => left.declarationOrder - right.declarationOrder)
        .map(member => ({
            member: member.member,
            port: member.port,
            direction: member.direction,
            portDirection: member.portDirection,
            width: cloneWidth(member.width),
            declarationOrder: member.declarationOrder,
        }));
    return {
        key: candidate.key,
        protocol: candidate.entry.protocol.id,
        protocolName: candidate.entry.protocol.name,
        protocolSource: candidate.entry.source,
        role,
        roleSource: role === 'unknown' ? 'unknown' : 'inferred',
        members,
        declarationOrder: candidate.firstOrder,
    };
}

function candidateKey(protocolId: string, normalizedInterfaceKey: string): string {
    return `${protocolId.length}:${protocolId}${normalizedInterfaceKey}`;
}

export function recognizeModuleInterfaces(
    ports: readonly InterfaceRecognitionPort[],
    catalog: InterfaceProtocolCatalog
): InterfaceRecognitionResult {
    const candidates = new Map<string, Candidate>();
    const suffixes = new Map(catalog.entries.map(entry => [
        entry.protocol.id,
        suffixMatches(entry.protocol),
    ]));
    const portSnapshots: InterfaceRecognitionPort[] = [];
    for (let index = 0; index < ports.length; index += 1) {
        const port = ports[index];
        portSnapshots.push({
            name: port.name,
            direction: port.direction,
            width: cloneWidth(port.width),
        });
    }

    for (let declarationOrder = 0; declarationOrder < portSnapshots.length; declarationOrder += 1) {
        const port = portSnapshots[declarationOrder];
        for (const entry of catalog.entries) {
            const matched = matchedPort(port.name, suffixes.get(entry.protocol.id) ?? []);
            if (!matched) continue;
            const normalizedKey = matched.key.toLowerCase();
            const key = candidateKey(entry.protocol.id, normalizedKey);
            let candidate = candidates.get(key);
            if (!candidate) {
                candidate = {
                    entry,
                    key: matched.key,
                    normalizedKey,
                    firstOrder: declarationOrder,
                    members: new Map(),
                    duplicatePorts: [],
                };
                candidates.set(key, candidate);
            }
            const normalizedMember = matched.match.member.toLowerCase();
            const existing = candidate.members.get(normalizedMember);
            if (existing) {
                candidate.duplicatePorts.push(existing.port, port.name);
                continue;
            }
            candidate.members.set(normalizedMember, {
                member: matched.match.member,
                port: port.name,
                direction: matched.match.direction,
                portDirection: port.direction,
                width: port.width,
                declarationOrder,
            });
        }
    }

    const diagnostics: InterfaceRecognitionDiagnostic[] = [];
    const qualifiedByInterface = new Map<string, QualifiedCandidate[]>();
    for (const candidate of candidates.values()) {
        const specificity = signatureSpecificity(candidate);
        if (specificity === 0) continue;
        if (candidate.duplicatePorts.length > 0) {
            diagnostics.push({
                code: 'IF_RECOGNITION_DUPLICATE_MEMBER',
                message: `Interface ${candidate.key} maps multiple ports to one protocol member`,
                interfaceKey: candidate.key,
                protocols: [candidate.entry.protocol.id],
                ports: [...new Set(candidate.duplicatePorts)].sort(compareCodeUnits),
            });
            continue;
        }
        const matches = qualifiedByInterface.get(candidate.normalizedKey);
        const qualified = { candidate, signatureSpecificity: specificity };
        if (matches) matches.push(qualified);
        else qualifiedByInterface.set(candidate.normalizedKey, [qualified]);
    }

    const interfaces: RecognizedInterface[] = [];
    for (const matches of qualifiedByInterface.values()) {
        matches.sort((left, right) =>
            compareCandidates(left, right)
            || compareCodeUnits(left.candidate.entry.protocol.id, right.candidate.entry.protocol.id));
        const selected = matches[0];
        const tied = matches.filter(candidate => compareCandidates(selected, candidate) === 0);
        if (tied.length > 1) {
            diagnostics.push({
                code: 'IF_RECOGNITION_AMBIGUOUS',
                message: `Interface ${selected.candidate.key} matches multiple protocols equally`,
                interfaceKey: selected.candidate.key,
                protocols: tied.map(candidate => candidate.candidate.entry.protocol.id)
                    .sort(compareCodeUnits),
            });
            continue;
        }
        interfaces.push(recognized(selected.candidate));
    }
    interfaces.sort((left, right) =>
        left.declarationOrder - right.declarationOrder
        || compareCodeUnits(left.key, right.key)
        || compareCodeUnits(left.protocol, right.protocol));
    diagnostics.sort((left, right) =>
        compareCodeUnits(left.interfaceKey.toLowerCase(), right.interfaceKey.toLowerCase())
        || compareCodeUnits(left.code, right.code));
    return deepFreeze({ interfaces, diagnostics });
}
