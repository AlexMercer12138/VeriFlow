import type { WidthValue } from '@veriflow/hdl-core/model';

import type { ArchDesignInstance, ArchDesignParameterValue } from './model';
import type {
    ArchDesignDefinitionParameter,
    ArchDesignModuleDefinition,
} from './definitions';

type Token =
    | Readonly<{ kind: 'number'; value: bigint }>
    | Readonly<{ kind: 'identifier'; value: string }>
    | Readonly<{ kind: 'operator'; value: string }>
    | Readonly<{ kind: 'end' }>;

const BINARY_PRECEDENCE = new Map<string, number>([
    ['||', 1],
    ['&&', 2],
    ['|', 3],
    ['^', 4],
    ['&', 5],
    ['==', 6],
    ['!=', 6],
    ['<', 7],
    ['<=', 7],
    ['>', 7],
    ['>=', 7],
    ['<<', 8],
    ['>>', 8],
    ['+', 9],
    ['-', 9],
    ['*', 10],
    ['/', 10],
    ['%', 10],
    ['**', 11],
]);
const MAX_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

function bounded(value: bigint): bigint {
    if (value < -MAX_VALUE || value > MAX_VALUE) throw new Error('out of range');
    return value;
}

function basedInteger(text: string): bigint | undefined {
    const match = /^(?:([0-9][0-9_]*)\s*)?'([sS])?([bBoOdDhH])([0-9a-fA-F_xXzZ?]+)$/.exec(text);
    if (!match || /[xXzZ?]/.test(match[4])) return undefined;
    const digits = match[4].replace(/_/g, '');
    const radix = match[3].toLowerCase() === 'b'
        ? 2
        : match[3].toLowerCase() === 'o' ? 8 : match[3].toLowerCase() === 'd' ? 10 : 16;
    let value = 0n;
    for (const digit of digits.toLowerCase()) {
        const parsed = digit >= '0' && digit <= '9'
            ? digit.charCodeAt(0) - 48
            : digit.charCodeAt(0) - 87;
        if (parsed < 0 || parsed >= radix) return undefined;
        value = bounded(value * BigInt(radix) + BigInt(parsed));
    }
    const size = match[1] === undefined ? undefined : Number(match[1].replace(/_/g, ''));
    if (match[2] && size !== undefined && size > 0 && size <= 53) {
        const signBit = 1n << BigInt(size - 1);
        const modulus = 1n << BigInt(size);
        if ((value & signBit) !== 0n) value -= modulus;
    }
    return bounded(value);
}

function tokenize(source: string): Token[] | undefined {
    const tokens: Token[] = [];
    let index = 0;
    while (index < source.length) {
        if (/\s/.test(source[index])) {
            index += 1;
            continue;
        }
        const rest = source.slice(index);
        const based = /^(?:[0-9][0-9_]*\s*)?'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+/.exec(rest);
        if (based) {
            const value = basedInteger(based[0]);
            if (value === undefined) return undefined;
            tokens.push({ kind: 'number', value });
            index += based[0].length;
            continue;
        }
        const decimal = /^[0-9][0-9_]*/.exec(rest);
        if (decimal) {
            tokens.push({
                kind: 'number',
                value: bounded(BigInt(decimal[0].replace(/_/g, ''))),
            });
            index += decimal[0].length;
            continue;
        }
        const identifier = /^[$A-Za-z_][$A-Za-z0-9_]*/.exec(rest);
        if (identifier) {
            tokens.push({ kind: 'identifier', value: identifier[0] });
            index += identifier[0].length;
            continue;
        }
        const operator = ['**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||']
            .find(candidate => rest.startsWith(candidate))
            ?? '+-*/%~!&|^<>()?:'.split('').find(candidate => rest.startsWith(candidate));
        if (!operator) return undefined;
        tokens.push({ kind: 'operator', value: operator });
        index += operator.length;
    }
    tokens.push({ kind: 'end' });
    return tokens;
}

function binary(operator: string, left: bigint, right: bigint): bigint {
    switch (operator) {
        case '+': return bounded(left + right);
        case '-': return bounded(left - right);
        case '*': return bounded(left * right);
        case '/': return bounded(left / right);
        case '%': return bounded(left % right);
        case '**':
            if (right < 0n || right > 1024n) throw new Error('invalid exponent');
            return bounded(left ** right);
        case '<<':
            if (right < 0n || right > 1024n) throw new Error('invalid shift');
            return bounded(left << right);
        case '>>':
            if (right < 0n || right > 1024n) throw new Error('invalid shift');
            return bounded(left >> right);
        case '&': return bounded(left & right);
        case '^': return bounded(left ^ right);
        case '|': return bounded(left | right);
        case '==': return left === right ? 1n : 0n;
        case '!=': return left !== right ? 1n : 0n;
        case '<': return left < right ? 1n : 0n;
        case '<=': return left <= right ? 1n : 0n;
        case '>': return left > right ? 1n : 0n;
        case '>=': return left >= right ? 1n : 0n;
        case '&&': return left !== 0n && right !== 0n ? 1n : 0n;
        case '||': return left !== 0n || right !== 0n ? 1n : 0n;
        default: throw new Error('unsupported operator');
    }
}

class ConstantExpressionParser {
    private index = 0;

    constructor(
        private readonly tokens: readonly Token[],
        private readonly resolveIdentifier: (name: string) => bigint | undefined
    ) {}

    parse(): bigint | undefined {
        try {
            const value = this.expression(0);
            return this.peek().kind === 'end' ? value : undefined;
        } catch {
            return undefined;
        }
    }

    private peek(): Token {
        return this.tokens[this.index] ?? { kind: 'end' };
    }

    private takeOperator(value: string): boolean {
        const token = this.peek();
        if (token.kind !== 'operator' || token.value !== value) return false;
        this.index += 1;
        return true;
    }

    private expression(minimumPrecedence: number): bigint {
        let left = this.unary();
        while (true) {
            const token = this.peek();
            if (token.kind !== 'operator') break;
            const precedence = BINARY_PRECEDENCE.get(token.value);
            if (precedence === undefined || precedence < minimumPrecedence) break;
            this.index += 1;
            const right = this.expression(precedence + (token.value === '**' ? 0 : 1));
            left = binary(token.value, left, right);
        }
        if (minimumPrecedence === 0 && this.takeOperator('?')) {
            const whenTrue = this.expression(0);
            if (!this.takeOperator(':')) throw new Error('missing colon');
            const whenFalse = this.expression(0);
            left = left === 0n ? whenFalse : whenTrue;
        }
        return left;
    }

    private unary(): bigint {
        const token = this.peek();
        if (token.kind === 'operator' && ['+', '-', '~', '!'].includes(token.value)) {
            this.index += 1;
            const value = this.unary();
            if (token.value === '+') return value;
            if (token.value === '-') return bounded(-value);
            if (token.value === '~') return bounded(~value);
            return value === 0n ? 1n : 0n;
        }
        return this.primary();
    }

    private primary(): bigint {
        const token = this.peek();
        if (token.kind === 'number') {
            this.index += 1;
            return token.value;
        }
        if (token.kind === 'identifier') {
            this.index += 1;
            if (token.value === '$clog2' && this.takeOperator('(')) {
                const argument = this.expression(0);
                if (!this.takeOperator(')') || argument < 0n) throw new Error('invalid clog2');
                if (argument <= 1n) return 0n;
                let value = argument - 1n;
                let bits = 0n;
                while (value > 0n) {
                    value >>= 1n;
                    bits += 1n;
                }
                return bits;
            }
            const value = this.resolveIdentifier(token.value);
            if (value === undefined) throw new Error('unknown identifier');
            return value;
        }
        if (this.takeOperator('(')) {
            const value = this.expression(0);
            if (!this.takeOperator(')')) throw new Error('missing parenthesis');
            return value;
        }
        throw new Error('expected expression');
    }
}

function evaluate(
    expression: string,
    resolveIdentifier: (name: string) => bigint | undefined
): bigint | undefined {
    try {
        const tokens = tokenize(expression);
        return tokens ? new ConstantExpressionParser(tokens, resolveIdentifier).parse() : undefined;
    } catch {
        return undefined;
    }
}

function parameterResolver(
    parameters: readonly ArchDesignDefinitionParameter[],
    overrides: Readonly<Record<string, ArchDesignParameterValue>> | undefined
): (name: string) => bigint | undefined {
    const definitions = new Map(parameters.map(parameter => [parameter.name, parameter]));
    const cache = new Map<string, bigint | undefined>();
    const resolving = new Set<string>();
    const resolve = (name: string): bigint | undefined => {
        if (cache.has(name)) return cache.get(name);
        if (resolving.has(name)) return undefined;
        const definition = definitions.get(name);
        if (!definition) return undefined;
        resolving.add(name);
        const override = overrides && Object.prototype.hasOwnProperty.call(overrides, name)
            ? overrides[name]
            : undefined;
        let value: bigint | undefined;
        if (typeof override === 'number' && Number.isSafeInteger(override)) {
            value = BigInt(override);
        } else if (typeof override === 'boolean') {
            value = override ? 1n : 0n;
        } else {
            const expression = typeof override === 'string'
                ? override
                : definition.defaultExpression;
            value = expression === undefined ? undefined : evaluate(expression, resolve);
        }
        resolving.delete(name);
        cache.set(name, value);
        return value;
    };
    return resolve;
}

function rangeWidth(
    expression: string,
    resolveIdentifier: (name: string) => bigint | undefined
): bigint | undefined {
    let index = 0;
    let total = 1n;
    let found = false;
    while (index < expression.length) {
        while (/\s/.test(expression[index] ?? '')) index += 1;
        if (index === expression.length) break;
        if (expression[index] !== '[') return undefined;
        let depth = 1;
        let cursor = index + 1;
        let colon = -1;
        for (; cursor < expression.length && depth > 0; cursor += 1) {
            const character = expression[cursor];
            if (character === '(') depth += 1;
            else if (character === ')') depth -= 1;
            else if (character === ':' && depth === 1 && colon < 0) colon = cursor;
            else if (character === ']' && depth === 1) {
                depth = 0;
                break;
            }
        }
        if (depth !== 0 || colon < 0) return undefined;
        const left = evaluate(expression.slice(index + 1, colon), resolveIdentifier);
        const right = evaluate(expression.slice(colon + 1, cursor), resolveIdentifier);
        if (left === undefined || right === undefined) return undefined;
        total = bounded(total * ((left >= right ? left - right : right - left) + 1n));
        found = true;
        index = cursor + 1;
    }
    return found ? total : undefined;
}

export function resolveInstancePortWidth(
    width: WidthValue,
    definition: ArchDesignModuleDefinition,
    instance: ArchDesignInstance
): WidthValue {
    if (width.kind !== 'symbolic') return width;
    const resolveParameter = parameterResolver(definition.parameters, instance.parameters);
    const value = width.expression.trim().startsWith('[')
        ? rangeWidth(width.expression, resolveParameter)
        : evaluate(width.expression, resolveParameter);
    if (value === undefined || value < 1n || value > MAX_VALUE) return width;
    return Object.freeze({ kind: 'known', bits: Number(value) });
}
