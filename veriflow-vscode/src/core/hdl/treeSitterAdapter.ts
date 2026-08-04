import { createHash } from 'crypto';
import type { Node, Tree } from 'web-tree-sitter';

import type { HdlDiagnostic, HdlDocument, ModuleModel, SourceSpan } from './model';
import { PositionMap } from './positionMap';
import type { ParseRequest } from './protocol';

type ByteRange = {
    startIndex: number;
    endIndex: number;
};

function sourceSpan(range: ByteRange, map: PositionMap, uri: string): SourceSpan {
    // web-tree-sitter's JavaScript input callback exposes UTF-16 indexes. Normalize
    // them to UTF-8 bytes so PositionMap remains the single byte-to-source boundary.
    const byteStart = map.utf16ToByte(range.startIndex);
    const byteEnd = map.utf16ToByte(range.endIndex);
    return {
        ...map.byteRangeToSourceRange(byteStart, byteEnd),
        uri,
    };
}

function offsetSpan(startIndex: number, endIndex: number): ByteRange {
    return { startIndex, endIndex };
}

function languageId(uri: string): HdlDocument['languageId'] {
    const path = uri.split(/[?#]/, 1)[0].toLowerCase();
    return path.endsWith('.sv') || path.endsWith('.svh')
        ? 'systemverilog'
        : 'verilog';
}

function adaptModule(
    node: Node,
    map: PositionMap,
    request: ParseRequest
): ModuleModel | undefined {
    const header = node.namedChildren.find(child =>
        child.type === 'module_ansi_header' || child.type === 'module_nonansi_header'
    );
    if (!header) {
        return undefined;
    }

    const nameNode = header.childForFieldName('name');
    if (!nameNode || nameNode.isMissing || nameNode.text.length === 0) {
        return undefined;
    }

    const children = node.children;
    const endmoduleIndex = children.findIndex(child => child.type === 'endmodule');
    const endmoduleNode = children[endmoduleIndex];
    const bodyStart = header.endIndex;
    const bodyEnd = endmoduleNode?.startIndex ?? node.endIndex;
    const endmoduleRange = endmoduleNode
        ?? offsetSpan(node.endIndex, node.endIndex);
    const labelSeparatorIndex = endmoduleIndex >= 0
        ? children.findIndex(
            (child, index) => index > endmoduleIndex && child.type === ':'
        )
        : -1;
    const endLabelNode = labelSeparatorIndex >= 0
        ? children.slice(labelSeparatorIndex + 1).find(child =>
            child.type === 'simple_identifier' || child.type === 'escaped_identifier'
        )
        : undefined;

    return {
        id: `${request.uri}#module:${nameNode.startIndex}`,
        name: nameNode.text,
        nameSpan: sourceSpan(nameNode, map, request.uri),
        endLabel: endLabelNode?.text,
        declarationStyle: header.type === 'module_ansi_header' ? 'ansi' : 'non-ansi',
        declarationSpan: sourceSpan(node, map, request.uri),
        headerSpan: sourceSpan(header, map, request.uri),
        bodySpan: sourceSpan(offsetSpan(bodyStart, bodyEnd), map, request.uri),
        declarationRegionSpan: sourceSpan(
            offsetSpan(bodyStart, bodyEnd),
            map,
            request.uri
        ),
        endmoduleSpan: sourceSpan(endmoduleRange, map, request.uri),
        parameters: [],
        localParameters: [],
        ports: [],
        portDeclarationGroups: [],
        instances: [],
        instanceDeclarationGroups: [],
    };
}

export function adaptTree(tree: Tree, request: ParseRequest): HdlDocument {
    const map = new PositionMap(request.text);
    const modules: ModuleModel[] = [];
    const diagnostics: HdlDiagnostic[] = [];
    const pending = [tree.rootNode];

    while (pending.length > 0) {
        const node = pending.pop()!;
        if (node.type === 'module_declaration') {
            const module = adaptModule(node, map, request);
            if (module) {
                modules.push(module);
            }
        }
        if (node.isMissing) {
            diagnostics.push({
                severity: 'error',
                code: 'systemverilog.missing-syntax',
                message: `Missing SystemVerilog syntax: ${node.type}`,
                span: sourceSpan(node, map, request.uri),
            });
        } else if (node.isError) {
            diagnostics.push({
                severity: 'error',
                code: 'systemverilog.syntax-error',
                message: 'SystemVerilog syntax error',
                span: sourceSpan(node, map, request.uri),
            });
        }

        const children = node.children;
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push(children[index]);
        }
    }

    return {
        uri: request.uri,
        languageId: languageId(request.uri),
        version: request.version,
        textHash: createHash('sha256').update(request.text).digest('hex'),
        lineEnding: request.text.includes('\r\n') ? '\r\n' : '\n',
        preprocessingFingerprint: 'none',
        modules,
        interfaces: [],
        packages: [],
        directives: [],
        includes: [],
        diagnostics,
    };
}
