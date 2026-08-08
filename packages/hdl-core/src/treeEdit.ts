export type ParserTreeEdit = {
    startIndex: number;
    oldEndIndex: number;
    newEndIndex: number;
    startPosition: { row: number; column: number };
    oldEndPosition: { row: number; column: number };
    newEndPosition: { row: number; column: number };
};

function isHighSurrogate(value: number): boolean {
    return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
    return value >= 0xdc00 && value <= 0xdfff;
}

function isCodePointBoundary(text: string, offset: number): boolean {
    return offset <= 0
        || offset >= text.length
        || !(
            isHighSurrogate(text.charCodeAt(offset - 1))
            && isLowSurrogate(text.charCodeAt(offset))
        );
}

function pointAt(text: string, offset: number): { row: number; column: number } {
    let row = 0;
    let lineStart = 0;
    for (let index = 0; index < offset; index++) {
        if (text.charCodeAt(index) === 0x0a) {
            row++;
            lineStart = index + 1;
        }
    }
    return {
        row,
        column: Buffer.byteLength(text.slice(lineStart, offset), 'utf8'),
    };
}

export function computeTreeEdit(
    oldText: string,
    newText: string
): ParserTreeEdit | undefined {
    if (oldText === newText) {
        return undefined;
    }

    const sharedLength = Math.min(oldText.length, newText.length);
    let start = 0;
    while (start < sharedLength && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
        start++;
    }
    while (!isCodePointBoundary(oldText, start) || !isCodePointBoundary(newText, start)) {
        start--;
    }

    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (
        oldEnd > start
        && newEnd > start
        && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
    ) {
        oldEnd--;
        newEnd--;
    }
    while (
        !isCodePointBoundary(oldText, oldEnd)
        || !isCodePointBoundary(newText, newEnd)
    ) {
        oldEnd++;
        newEnd++;
    }

    return {
        startIndex: Buffer.byteLength(oldText.slice(0, start), 'utf8'),
        oldEndIndex: Buffer.byteLength(oldText.slice(0, oldEnd), 'utf8'),
        newEndIndex: Buffer.byteLength(newText.slice(0, newEnd), 'utf8'),
        startPosition: pointAt(oldText, start),
        oldEndPosition: pointAt(oldText, oldEnd),
        newEndPosition: pointAt(newText, newEnd),
    };
}
