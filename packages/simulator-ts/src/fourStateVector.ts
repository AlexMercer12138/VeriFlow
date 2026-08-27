import { SimulatorTsError } from './diagnostics';

export type LogicBit = '0' | '1' | 'x' | 'z';
export type EdgeClassification = 'none' | 'posedge' | 'negedge';

const BITS_PER_WORD = 32;
const MAX_VECTOR_WIDTH = 1_048_576;
const CONSTRUCT_VECTOR = Symbol('construct-vector');
const TAKE_PLANE_OWNERSHIP = Symbol('take-plane-ownership');

type PlaneStorage = number | Uint32Array;

export interface FourStateVectorOptions {
    signed?: boolean;
}

export class FourStateVector {
    readonly #values: PlaneStorage;
    readonly #unknowns: PlaneStorage;

    private constructor(
        public readonly width: number,
        public readonly signed: boolean,
        values: PlaneStorage,
        unknowns: PlaneStorage,
        token: typeof CONSTRUCT_VECTOR,
    ) {
        if (token !== CONSTRUCT_VECTOR) {
            throw new SimulatorTsError(
                'SIM_TS_INVALID_VALUE',
                'four-state vectors must be created through a validated factory',
            );
        }
        this.#values = values;
        this.#unknowns = unknowns;
        Object.freeze(this);
    }

    public static fromBits(
        input: string,
        options: FourStateVectorOptions = {},
    ): FourStateVector {
        if (typeof input !== 'string' || input.length === 0) {
            throw new SimulatorTsError(
                'SIM_TS_INVALID_VALUE',
                'four-state value must contain at least one bit',
            );
        }
        validateWidth(input.length);
        const bits = input.toLowerCase();
        if (!/^[01xz]+$/u.test(bits)) {
            throw new SimulatorTsError(
                'SIM_TS_INVALID_VALUE',
                `invalid four-state value: ${JSON.stringify(input)}`,
            );
        }
        const width = bits.length;
        const storage = createEmptyPlanes(width);
        for (let sourceIndex = 0; sourceIndex < width; sourceIndex += 1) {
            const bit = bits[sourceIndex] as LogicBit;
            const bitIndex = width - sourceIndex - 1;
            if (bit === '1' || bit === 'z') {
                storage.values = setPlaneBit(storage.values, bitIndex);
            }
            if (bit === 'x' || bit === 'z') {
                storage.unknowns = setPlaneBit(storage.unknowns, bitIndex);
            }
        }
        return new FourStateVector(
            width,
            options.signed === true,
            storage.values,
            storage.unknowns,
            CONSTRUCT_VECTOR,
        );
    }

    /** @internal */
    public static fromPlanes(
        width: number,
        signed: boolean,
        values: PlaneStorage,
        unknowns: PlaneStorage,
        ownership?: typeof TAKE_PLANE_OWNERSHIP,
    ): FourStateVector {
        validateWidth(width);
        const expectedWords = wordCount(width);
        if (width <= BITS_PER_WORD) {
            if (typeof values !== 'number' || typeof unknowns !== 'number') {
                throw new SimulatorTsError(
                    'SIM_TS_INVALID_VALUE',
                    'scalar planes must use number storage',
                );
            }
            const mask = finalWordMask(width);
            return new FourStateVector(
                width,
                signed,
                (values & mask) >>> 0,
                (unknowns & mask) >>> 0,
                CONSTRUCT_VECTOR,
            );
        }
        if (!(values instanceof Uint32Array)
            || !(unknowns instanceof Uint32Array)
            || values.length !== expectedWords
            || unknowns.length !== expectedWords) {
            throw new SimulatorTsError(
                'SIM_TS_INVALID_VALUE',
                `wide planes must contain exactly ${expectedWords} words`,
            );
        }
        const ownedValues = ownership === TAKE_PLANE_OWNERSHIP
            ? values
            : new Uint32Array(values);
        const ownedUnknowns = ownership === TAKE_PLANE_OWNERSHIP
            ? unknowns
            : new Uint32Array(unknowns);
        const mask = finalWordMask(width);
        ownedValues[ownedValues.length - 1] &= mask;
        ownedUnknowns[ownedUnknowns.length - 1] &= mask;
        return new FourStateVector(
            width,
            signed,
            ownedValues,
            ownedUnknowns,
            CONSTRUCT_VECTOR,
        );
    }

    public bit(index: number): LogicBit {
        if (!Number.isInteger(index) || index < 0 || index >= this.width) {
            throw new SimulatorTsError(
                'SIM_TS_INVALID_RANGE',
                `bit index ${index} is outside width ${this.width}`,
            );
        }
        const wordIndex = Math.floor(index / BITS_PER_WORD);
        const mask = (1 << (index % BITS_PER_WORD)) >>> 0;
        const unknown = (this.unknownWord(wordIndex) & mask) !== 0;
        const value = (this.valueWord(wordIndex) & mask) !== 0;
        if (!unknown) return value ? '1' : '0';
        return value ? 'z' : 'x';
    }

    public toBits(): string {
        const bits = new Array<string>(this.width);
        for (let bitIndex = this.width - 1; bitIndex >= 0; bitIndex -= 1) {
            bits[this.width - bitIndex - 1] = this.bit(bitIndex);
        }
        return bits.join('');
    }

    public not(): FourStateVector {
        const output = createEmptyPlanes(this.width);
        for (let index = 0; index < wordCount(this.width); index += 1) {
            const mask = maskForWord(this.width, index);
            const unknown = this.unknownWord(index);
            output.unknowns = writePlaneWord(output.unknowns, index, unknown & mask);
            output.values = writePlaneWord(
                output.values,
                index,
                ((~this.valueWord(index)) & (~unknown) & mask) >>> 0,
            );
        }
        return FourStateVector.fromPlanes(
            this.width,
            this.signed,
            output.values,
            output.unknowns,
            TAKE_PLANE_OWNERSHIP,
        );
    }

    public and(right: FourStateVector): FourStateVector {
        return this.binary(right, 'and');
    }

    public or(right: FourStateVector): FourStateVector {
        return this.binary(right, 'or');
    }

    public xor(right: FourStateVector): FourStateVector {
        return this.binary(right, 'xor');
    }

    public logicalEqual(right: FourStateVector): LogicBit {
        const width = Math.max(this.width, right.width);
        const signed = this.signed && right.signed;
        let differs = false;
        let hasUnknown = false;
        for (let index = 0; index < wordCount(width); index += 1) {
            const leftWord = extendedWords(this, index, width, signed);
            const rightWord = extendedWords(right, index, width, signed);
            const mask = maskForWord(width, index);
            const unknowns = (leftWord.unknowns | rightWord.unknowns) & mask;
            const knowns = (~unknowns) & mask;
            hasUnknown ||= unknowns !== 0;
            differs ||= ((leftWord.values ^ rightWord.values) & knowns) !== 0;
        }
        if (differs) return '0';
        return hasUnknown ? 'x' : '1';
    }

    public caseEqual(right: FourStateVector): LogicBit {
        const width = Math.max(this.width, right.width);
        const signed = this.signed && right.signed;
        for (let index = 0; index < wordCount(width); index += 1) {
            const leftWord = extendedWords(this, index, width, signed);
            const rightWord = extendedWords(right, index, width, signed);
            if (leftWord.values !== rightWord.values
                || leftWord.unknowns !== rightWord.unknowns) {
                return '0';
            }
        }
        return '1';
    }

    public reduceAnd(): LogicBit {
        let hasUnknown = false;
        for (let index = 0; index < wordCount(this.width); index += 1) {
            const mask = maskForWord(this.width, index);
            const unknown = this.unknownWord(index) & mask;
            const knownZero = (~unknown) & (~this.valueWord(index)) & mask;
            if (knownZero !== 0) return '0';
            hasUnknown ||= unknown !== 0;
        }
        return hasUnknown ? 'x' : '1';
    }

    public reduceOr(): LogicBit {
        let hasUnknown = false;
        for (let index = 0; index < wordCount(this.width); index += 1) {
            const mask = maskForWord(this.width, index);
            const unknown = this.unknownWord(index) & mask;
            const knownOne = (~unknown) & this.valueWord(index) & mask;
            if (knownOne !== 0) return '1';
            hasUnknown ||= unknown !== 0;
        }
        return hasUnknown ? 'x' : '0';
    }

    public reduceXor(): LogicBit {
        let parity = 0;
        for (let index = 0; index < wordCount(this.width); index += 1) {
            const mask = maskForWord(this.width, index);
            if ((this.unknownWord(index) & mask) !== 0) return 'x';
            parity ^= parity32(this.valueWord(index) & mask);
        }
        return parity === 0 ? '0' : '1';
    }

    public resize(width: number): FourStateVector {
        validateWidth(width);
        if (width === this.width) return this;
        const output = createEmptyPlanes(width);
        const extendSigned = this.signed;
        for (let index = 0; index < wordCount(width); index += 1) {
            const word = extendedWords(this, index, width, extendSigned);
            output.values = writePlaneWord(output.values, index, word.values);
            output.unknowns = writePlaneWord(output.unknowns, index, word.unknowns);
        }
        return FourStateVector.fromPlanes(
            width,
            this.signed,
            output.values,
            output.unknowns,
            TAKE_PLANE_OWNERSHIP,
        );
    }

    public slice(msb: number, lsb: number): FourStateVector {
        if (!Number.isInteger(msb)
            || !Number.isInteger(lsb)
            || lsb < 0
            || msb < lsb
            || msb >= this.width) {
            throw new SimulatorTsError(
                'SIM_TS_INVALID_RANGE',
                `invalid part-select [${msb}:${lsb}] for width ${this.width}`,
            );
        }
        const width = msb - lsb + 1;
        const output = createEmptyPlanes(width);
        for (let index = 0; index < wordCount(width); index += 1) {
            const startBit = lsb + index * BITS_PER_WORD;
            const mask = maskForWord(width, index);
            output.values = writePlaneWord(
                output.values,
                index,
                extractWord(this, startBit, false) & mask,
            );
            output.unknowns = writePlaneWord(
                output.unknowns,
                index,
                extractWord(this, startBit, true) & mask,
            );
        }
        return FourStateVector.fromPlanes(
            width,
            false,
            output.values,
            output.unknowns,
            TAKE_PLANE_OWNERSHIP,
        );
    }

    public static concat(parts: readonly FourStateVector[]): FourStateVector {
        if (parts.length === 0) {
            throw new SimulatorTsError(
                'SIM_TS_INVALID_VALUE',
                'concatenation requires at least one operand',
            );
        }
        const width = parts.reduce((total, part) => {
            const next = total + part.width;
            validateWidth(next);
            return next;
        }, 0);
        const output = createEmptyPlanes(width);
        let destinationBit = 0;
        for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = parts[partIndex];
            for (let sourceBit = 0; sourceBit < part.width; sourceBit += 1) {
                const state = part.bit(sourceBit);
                if (state === '1' || state === 'z') {
                    output.values = setPlaneBit(output.values, destinationBit);
                }
                if (state === 'x' || state === 'z') {
                    output.unknowns = setPlaneBit(output.unknowns, destinationBit);
                }
                destinationBit += 1;
            }
        }
        return FourStateVector.fromPlanes(
            width,
            false,
            output.values,
            output.unknowns,
            TAKE_PLANE_OWNERSHIP,
        );
    }

    public static conditionalMerge(
        condition: LogicBit,
        whenTrue: FourStateVector,
        whenFalse: FourStateVector,
    ): FourStateVector {
        validateLogicBit(condition);
        const width = Math.max(whenTrue.width, whenFalse.width);
        const signed = whenTrue.signed && whenFalse.signed;
        const output = createEmptyPlanes(width);
        for (let index = 0; index < wordCount(width); index += 1) {
            const trueWord = extendedWords(whenTrue, index, width, signed);
            const falseWord = extendedWords(whenFalse, index, width, signed);
            if (condition === '1') {
                output.values = writePlaneWord(output.values, index, trueWord.values);
                output.unknowns = writePlaneWord(output.unknowns, index, trueWord.unknowns);
            } else if (condition === '0') {
                output.values = writePlaneWord(output.values, index, falseWord.values);
                output.unknowns = writePlaneWord(output.unknowns, index, falseWord.unknowns);
            } else {
                const mask = maskForWord(width, index);
                const same = (~(
                    (trueWord.values ^ falseWord.values)
                    | (trueWord.unknowns ^ falseWord.unknowns)
                )) & mask;
                output.values = writePlaneWord(output.values, index, trueWord.values & same);
                output.unknowns = writePlaneWord(
                    output.unknowns,
                    index,
                    (trueWord.unknowns & same) | ((~same) & mask),
                );
            }
        }
        return FourStateVector.fromPlanes(
            width,
            signed,
            output.values,
            output.unknowns,
            TAKE_PLANE_OWNERSHIP,
        );
    }

    /** @internal */
    public valueWord(index: number): number {
        if (typeof this.#values === 'number') return index === 0 ? this.#values : 0;
        return this.#values[index] ?? 0;
    }

    /** @internal */
    public unknownWord(index: number): number {
        if (typeof this.#unknowns === 'number') return index === 0 ? this.#unknowns : 0;
        return this.#unknowns[index] ?? 0;
    }

    /** @internal */
    public copyWidePlanesTo(
        values: Uint32Array,
        unknowns: Uint32Array,
    ): void {
        if (!(this.#values instanceof Uint32Array)
            || !(this.#unknowns instanceof Uint32Array)
            || values.length !== this.#values.length
            || unknowns.length !== this.#unknowns.length) {
            throw new SimulatorTsError(
                'SIM_TS_WIDTH_MISMATCH',
                'wide plane copy requires matching limb storage',
            );
        }
        values.set(this.#values);
        unknowns.set(this.#unknowns);
    }

    private binary(
        right: FourStateVector,
        operation: 'and' | 'or' | 'xor',
    ): FourStateVector {
        const width = Math.max(this.width, right.width);
        const signed = this.signed && right.signed;
        const output = createEmptyPlanes(width);
        for (let index = 0; index < wordCount(width); index += 1) {
            const leftWord = extendedWords(this, index, width, signed);
            const rightWord = extendedWords(right, index, width, signed);
            const word = binaryWord(operation, leftWord, rightWord, maskForWord(width, index));
            output.values = writePlaneWord(output.values, index, word.values);
            output.unknowns = writePlaneWord(output.unknowns, index, word.unknowns);
        }
        return FourStateVector.fromPlanes(
            width,
            signed,
            output.values,
            output.unknowns,
            TAKE_PLANE_OWNERSHIP,
        );
    }
}

/** @internal */
export class FourStateScratch {
    private scalarValues = 0;
    private scalarUnknowns = 0;
    private readonly valueWords?: Uint32Array;
    private readonly unknownWords?: Uint32Array;

    constructor(public readonly width: number) {
        validateWidth(width);
        if (width > BITS_PER_WORD) {
            this.valueWords = new Uint32Array(wordCount(width));
            this.unknownWords = new Uint32Array(wordCount(width));
        }
    }

    public assign(source: FourStateVector): this {
        this.requireWidth(source);
        if (this.width > BITS_PER_WORD) {
            source.copyWidePlanesTo(this.valueWords!, this.unknownWords!);
            return this;
        }
        for (let index = 0; index < wordCount(this.width); index += 1) {
            this.writeWord(
                index,
                source.valueWord(index),
                source.unknownWord(index),
            );
        }
        return this;
    }

    public assignNot(source: FourStateVector): this {
        this.requireWidth(source);
        for (let index = 0; index < wordCount(this.width); index += 1) {
            const mask = maskForWord(this.width, index);
            const unknown = source.unknownWord(index);
            this.writeWord(
                index,
                ((~source.valueWord(index)) & (~unknown) & mask) >>> 0,
                unknown & mask,
            );
        }
        return this;
    }

    public assignAnd(left: FourStateVector, right: FourStateVector): this {
        return this.assignBinary(left, right, 'and');
    }

    public assignOr(left: FourStateVector, right: FourStateVector): this {
        return this.assignBinary(left, right, 'or');
    }

    public assignXor(left: FourStateVector, right: FourStateVector): this {
        return this.assignBinary(left, right, 'xor');
    }

    public snapshot(options: FourStateVectorOptions = {}): FourStateVector {
        if (this.width <= BITS_PER_WORD) {
            return FourStateVector.fromPlanes(
                this.width,
                options.signed === true,
                this.scalarValues,
                this.scalarUnknowns,
            );
        }
        return FourStateVector.fromPlanes(
            this.width,
            options.signed === true,
            this.valueWords!,
            this.unknownWords!,
        );
    }

    private assignBinary(
        left: FourStateVector,
        right: FourStateVector,
        operation: 'and' | 'or' | 'xor',
    ): this {
        this.requireWidth(left);
        this.requireWidth(right);
        for (let index = 0; index < wordCount(this.width); index += 1) {
            const mask = maskForWord(this.width, index);
            const leftValues = left.valueWord(index);
            const leftUnknowns = left.unknownWord(index);
            const rightValues = right.valueWord(index);
            const rightUnknowns = right.unknownWord(index);
            const leftKnownZero = (~leftUnknowns) & (~leftValues) & mask;
            const rightKnownZero = (~rightUnknowns) & (~rightValues) & mask;
            const leftKnownOne = (~leftUnknowns) & leftValues & mask;
            const rightKnownOne = (~rightUnknowns) & rightValues & mask;
            let knownZero: number;
            let knownOne: number;
            if (operation === 'and') {
                knownZero = leftKnownZero | rightKnownZero;
                knownOne = leftKnownOne & rightKnownOne;
            } else if (operation === 'or') {
                knownZero = leftKnownZero & rightKnownZero;
                knownOne = leftKnownOne | rightKnownOne;
            } else {
                const known = (~(leftUnknowns | rightUnknowns)) & mask;
                knownOne = (leftValues ^ rightValues) & known;
                knownZero = (~knownOne) & known;
            }
            this.writeWord(
                index,
                knownOne,
                (~(knownZero | knownOne)) & mask,
            );
        }
        return this;
    }

    private requireWidth(source: FourStateVector): void {
        if (source.width !== this.width) {
            throw new SimulatorTsError(
                'SIM_TS_WIDTH_MISMATCH',
                `scratch width ${this.width} does not match source width ${source.width}`,
            );
        }
    }

    private writeWord(index: number, values: number, unknowns: number): void {
        if (this.width <= BITS_PER_WORD) {
            this.scalarValues = values >>> 0;
            this.scalarUnknowns = unknowns >>> 0;
        } else {
            this.valueWords![index] = values >>> 0;
            this.unknownWords![index] = unknowns >>> 0;
        }
    }
}

export function classifyEdge(previous: LogicBit, next: LogicBit): EdgeClassification {
    validateLogicBit(previous);
    validateLogicBit(next);
    if ((previous === '0' && next !== '0')
        || ((previous === 'x' || previous === 'z') && next === '1')) {
        return 'posedge';
    }
    if ((previous === '1' && next !== '1')
        || ((previous === 'x' || previous === 'z') && next === '0')) {
        return 'negedge';
    }
    return 'none';
}

interface WordPlanes {
    values: number;
    unknowns: number;
}

function createEmptyPlanes(width: number): { values: PlaneStorage; unknowns: PlaneStorage } {
    if (width <= BITS_PER_WORD) return { values: 0, unknowns: 0 };
    const words = wordCount(width);
    return {
        values: new Uint32Array(words),
        unknowns: new Uint32Array(words),
    };
}

function binaryWord(
    operation: 'and' | 'or' | 'xor',
    left: WordPlanes,
    right: WordPlanes,
    mask: number,
): WordPlanes {
    const leftKnownZero = (~left.unknowns) & (~left.values) & mask;
    const rightKnownZero = (~right.unknowns) & (~right.values) & mask;
    const leftKnownOne = (~left.unknowns) & left.values & mask;
    const rightKnownOne = (~right.unknowns) & right.values & mask;
    let knownZero: number;
    let knownOne: number;
    if (operation === 'and') {
        knownZero = leftKnownZero | rightKnownZero;
        knownOne = leftKnownOne & rightKnownOne;
    } else if (operation === 'or') {
        knownZero = leftKnownZero & rightKnownZero;
        knownOne = leftKnownOne | rightKnownOne;
    } else {
        const known = (~(left.unknowns | right.unknowns)) & mask;
        knownOne = (left.values ^ right.values) & known;
        knownZero = (~knownOne) & known;
    }
    return {
        values: knownOne >>> 0,
        unknowns: ((~(knownZero | knownOne)) & mask) >>> 0,
    };
}

function extendedWords(
    source: FourStateVector,
    index: number,
    targetWidth: number,
    signExtend: boolean,
): WordPlanes {
    const wordStart = index * BITS_PER_WORD;
    const mask = maskForWord(targetWidth, index);
    let values = source.valueWord(index) & mask;
    let unknowns = source.unknownWord(index) & mask;
    if (signExtend && wordStart + BITS_PER_WORD > source.width) {
        const firstExtensionBit = Math.max(source.width - wordStart, 0);
        const extensionMask = mask & (~lowBitsMask(firstExtensionBit));
        const signBit = source.bit(source.width - 1);
        if (signBit === '1' || signBit === 'z') values |= extensionMask;
        if (signBit === 'x' || signBit === 'z') unknowns |= extensionMask;
    }
    return { values: values >>> 0, unknowns: unknowns >>> 0 };
}

function extractWord(
    source: FourStateVector,
    startBit: number,
    unknown: boolean,
): number {
    const sourceWord = Math.floor(startBit / BITS_PER_WORD);
    const offset = startBit % BITS_PER_WORD;
    const read = (index: number) => (
        unknown ? source.unknownWord(index) : source.valueWord(index)
    );
    if (offset === 0) return read(sourceWord);
    return (
        (read(sourceWord) >>> offset)
        | (read(sourceWord + 1) << (BITS_PER_WORD - offset))
    ) >>> 0;
}

function setPlaneBit(storage: PlaneStorage, bitIndex: number): PlaneStorage {
    const mask = (1 << (bitIndex % BITS_PER_WORD)) >>> 0;
    if (typeof storage === 'number') {
        return (storage | mask) >>> 0;
    }
    storage[Math.floor(bitIndex / BITS_PER_WORD)] |= mask;
    return storage;
}

function writePlaneWord(
    storage: PlaneStorage,
    index: number,
    value: number,
): PlaneStorage {
    if (typeof storage === 'number') {
        return value >>> 0;
    }
    storage[index] = value >>> 0;
    return storage;
}

function wordCount(width: number): number {
    return Math.ceil(width / BITS_PER_WORD);
}

function maskForWord(width: number, index: number): number {
    return index === wordCount(width) - 1 ? finalWordMask(width) : 0xffff_ffff;
}

function finalWordMask(width: number): number {
    const bits = width % BITS_PER_WORD;
    return bits === 0 ? 0xffff_ffff : lowBitsMask(bits);
}

function lowBitsMask(bits: number): number {
    if (bits <= 0) return 0;
    if (bits >= BITS_PER_WORD) return 0xffff_ffff;
    return (2 ** bits - 1) >>> 0;
}

function parity32(input: number): number {
    let value = input >>> 0;
    value ^= value >>> 16;
    value ^= value >>> 8;
    value ^= value >>> 4;
    value &= 0xf;
    return (0x6996 >>> value) & 1;
}

function validateWidth(width: number): void {
    if (!Number.isSafeInteger(width) || width <= 0 || width > MAX_VECTOR_WIDTH) {
        throw new SimulatorTsError(
            'SIM_TS_INVALID_WIDTH',
            `four-state width must be between 1 and ${MAX_VECTOR_WIDTH}: ${width}`,
        );
    }
}

function validateLogicBit(bit: string): asserts bit is LogicBit {
    if (bit !== '0' && bit !== '1' && bit !== 'x' && bit !== 'z') {
        throw new SimulatorTsError(
            'SIM_TS_INVALID_VALUE',
            `invalid four-state bit: ${JSON.stringify(bit)}`,
        );
    }
}
