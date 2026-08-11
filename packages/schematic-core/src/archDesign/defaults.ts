const MAX_DEFAULT_EXPRESSION_LENGTH = 4096;
const SAFE_SYSTEM_FUNCTIONS = new Set([
    '$bits',
    '$clog2',
    '$dimensions',
    '$high',
    '$increment',
    '$left',
    '$low',
    '$right',
    '$signed',
    '$size',
    '$unpacked_dimensions',
    '$unsigned',
]);

function isIdentifierStart(character: string): boolean {
    return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
    return /[A-Za-z0-9_$]/.test(character);
}

function basedLiteralEnd(source: string, quoteIndex: number): number | undefined {
    let index = quoteIndex + 1;
    if (source[index] === 's' || source[index] === 'S') index += 1;
    const base = source[index]?.toLowerCase();
    if (!base || !'bodh'.includes(base)) return undefined;
    index += 1;
    const digitsStart = index;
    const digitPattern = base === 'b'
        ? /[01_xXzZ?]/
        : base === 'o'
            ? /[0-7_xXzZ?]/
            : base === 'd'
                ? /[0-9_xXzZ?]/
                : /[0-9A-Fa-f_xXzZ?]/;
    while (digitPattern.test(source[index] ?? '')) index += 1;
    return index === digitsStart || isIdentifierPart(source[index] ?? '')
        ? undefined
        : index;
}

/**
 * Checks that a default consists only of conservative Verilog constant-expression tokens.
 * This deliberately validates safety and delimiter balance, not HDL grammar.
 */
export function isSafeDefaultExpression(expression: string): boolean {
    if (
        typeof expression !== 'string'
        || expression.length === 0
        || expression.length > MAX_DEFAULT_EXPRESSION_LENGTH
        || expression.trim().length === 0
        || expression.includes('`')
        || expression.includes(';')
        || expression.includes('//')
        || expression.includes('/*')
        || expression.includes('"')
    ) {
        return false;
    }

    for (let index = 0; index < expression.length; index += 1) {
        const code = expression.charCodeAt(index);
        if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
    }

    const closing = new Map<string, string>([[')', '('], [']', '['], ['}', '{']]);
    const stack: string[] = [];
    let index = 0;
    while (index < expression.length) {
        const character = expression[index];
        if (character === ' ' || character === '\t') {
            index += 1;
            continue;
        }
        if (character === '$') {
            const start = index;
            index += 1;
            if (!isIdentifierStart(expression[index] ?? '')) return false;
            while (isIdentifierPart(expression[index] ?? '')) index += 1;
            if (!SAFE_SYSTEM_FUNCTIONS.has(expression.slice(start, index))) return false;
            continue;
        }
        if (isIdentifierStart(character)) {
            index += 1;
            while (isIdentifierPart(expression[index] ?? '')) index += 1;
            continue;
        }
        if (/[0-9]/.test(character)) {
            index += 1;
            while (/[0-9_]/.test(expression[index] ?? '')) index += 1;
            if (expression[index] === "'") {
                const end = basedLiteralEnd(expression, index);
                if (end === undefined) return false;
                index = end;
            }
            continue;
        }
        if (character === "'") {
            if (index > 0 && isIdentifierPart(expression[index - 1])) return false;
            const unbased = expression[index + 1];
            if (/[01xXzZ]/.test(unbased ?? '')) {
                if (isIdentifierPart(expression[index + 2] ?? '')) return false;
                index += 2;
                continue;
            }
            const end = basedLiteralEnd(expression, index);
            if (end === undefined) return false;
            index = end;
            continue;
        }
        if (character === '(' || character === '[' || character === '{') {
            stack.push(character);
            index += 1;
            continue;
        }
        const expectedOpening = closing.get(character);
        if (expectedOpening !== undefined) {
            if (stack.pop() !== expectedOpening) return false;
            index += 1;
            continue;
        }
        if ('+-*/%&|^~!<>=?:,.'.includes(character)) {
            index += 1;
            continue;
        }
        return false;
    }
    return stack.length === 0;
}
