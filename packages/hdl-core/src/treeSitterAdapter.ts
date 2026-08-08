import { createHash } from 'crypto';

import type {
    ContinuousAssignModel,
    DirectiveModel,
    ExpressionModel,
    HdlDiagnostic,
    HdlDocument,
    IncludeModel,
    InstanceConnectionModel,
    InstanceDeclarationGroupModel,
    InstanceModel,
    ModuleModel,
    ModuleSymbolModel,
    NamedUnitModel,
    NetDeclarationModel,
    OpaqueLogicModel,
    ParameterModel,
    PortDeclarationGroupModel,
    PortModel,
    SourceSpan,
    SymbolReferenceModel,
    WidthValue,
} from './model';
import { PositionMap } from './positionMap';
import { CompositeSourceMap } from './preprocessor';

export interface HdlSyntaxNode {
    readonly type: string;
    readonly text: string;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly isMissing: boolean;
    readonly isError: boolean;
    readonly parent: HdlSyntaxNode | null;
    readonly children: HdlSyntaxNode[];
    readonly namedChildren: HdlSyntaxNode[];
    childForFieldName(name: string): HdlSyntaxNode | null;
}

export interface HdlSyntaxTree {
    readonly rootNode: HdlSyntaxNode;
}

export type HdlSourceInput = {
    uri: string;
    version: number;
    text: string;
};

type ByteRange = {
    startIndex: number;
    endIndex: number;
};

type AdaptContext = {
    map: PositionMap;
    request: HdlSourceInput;
    sourceMap: CompositeSourceMap;
    sourceTexts: Readonly<Record<string, string>>;
    transformedText: string;
    lineStartsByUri: Map<string, readonly number[]>;
};

export type AdapterSourceContext = {
    text: string;
    sourceMap: CompositeSourceMap;
    sourceTexts: Readonly<Record<string, string>>;
};

type PendingReference = Omit<SymbolReferenceModel, 'symbolId'> & {
    bindingEligible: boolean;
};

type ReferenceCandidate = {
    node: HdlSyntaxNode;
    bindingEligible: boolean;
};

const identifierTypes = new Set(['simple_identifier', 'escaped_identifier']);
const opaqueTypes = new Set([
    'always_construct',
    'initial_construct',
    'final_construct',
    'task_declaration',
    'function_declaration',
]);

export type TreeMacroUsageContext = {
    generatedStart: number;
    generatedEnd: number;
    structural: boolean;
};

const nonStructuralMacroAncestorTypes = new Set([
    ...opaqueTypes,
    'continuous_assign',
    'statement',
    'statement_item',
    'seq_block',
    'par_block',
]);

export function classifyTreeMacroUsages(tree: HdlSyntaxTree): TreeMacroUsageContext[] {
    const usages: TreeMacroUsageContext[] = [];
    const pending: Array<{ node: HdlSyntaxNode; nonStructural: boolean }> = [{
        node: tree.rootNode,
        nonStructural: false,
    }];
    while (pending.length > 0) {
        const current = pending.pop()!;
        const nonStructural = current.nonStructural
            || nonStructuralMacroAncestorTypes.has(current.node.type);
        if (current.node.type === 'text_macro_usage') {
            usages.push({
                generatedStart: current.node.startIndex,
                generatedEnd: current.node.endIndex,
                structural: !nonStructural,
            });
        }
        const children = current.node.namedChildren;
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push({ node: children[index], nonStructural });
        }
    }
    return usages.sort((left, right) =>
        left.generatedStart - right.generatedStart
        || left.generatedEnd - right.generatedEnd
    );
}

function sourceSpan(range: ByteRange, context: AdaptContext): SourceSpan {
    // web-tree-sitter's JavaScript input callback exposes UTF-16 indexes. Normalize
    // them to UTF-8 bytes so PositionMap remains the single byte-to-source boundary.
    const byteStart = context.map.utf16ToByte(range.startIndex);
    const byteEnd = context.map.utf16ToByte(range.endIndex);
    const compositeRange = context.map.byteRangeToSourceRange(byteStart, byteEnd);
    return context.sourceMap.mapSpan(compositeRange.start, compositeRange.end);
}

function declarationLine(range: ByteRange, context: AdaptContext): number {
    const start = context.sourceMap.mapOffset(range.startIndex, 'start');
    const text = context.sourceTexts[start.uri] ?? context.transformedText;
    const offset = context.sourceTexts[start.uri] === undefined ? range.startIndex : start.start;
    let lineStarts = context.lineStartsByUri.get(start.uri);
    if (!lineStarts) {
        const starts = [0];
        for (let index = 0; index < text.length; index++) {
            if (text.charCodeAt(index) === 10) {
                starts.push(index + 1);
            }
        }
        lineStarts = starts;
        context.lineStartsByUri.set(start.uri, lineStarts);
    }
    let lineIndex = 0;
    let upperBound = lineStarts.length;
    while (lineIndex + 1 < upperBound) {
        const middle = Math.floor((lineIndex + upperBound) / 2);
        if (lineStarts[middle] <= offset) {
            lineIndex = middle;
        } else {
            upperBound = middle;
        }
    }
    return lineIndex + 1;
}

function offsetSpan(startIndex: number, endIndex: number): ByteRange {
    return { startIndex, endIndex };
}

function stableId(kind: string, name: string, startIndex: number, uri: string): string {
    return `${uri}#${kind}:${name}:${startIndex}`;
}

function languageId(uri: string): HdlDocument['languageId'] {
    const path = uri.split(/[?#]/, 1)[0].toLowerCase();
    return path.endsWith('.sv') || path.endsWith('.svh')
        ? 'systemverilog'
        : 'verilog';
}

function descendants(node: HdlSyntaxNode, predicate: (candidate: HdlSyntaxNode) => boolean): HdlSyntaxNode[] {
    const result: HdlSyntaxNode[] = [];
    const pending = [...node.namedChildren].reverse();
    while (pending.length > 0) {
        const candidate = pending.pop()!;
        if (predicate(candidate)) {
            result.push(candidate);
        }
        const children = candidate.namedChildren;
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push(children[index]);
        }
    }
    return result;
}

function firstDescendant(node: HdlSyntaxNode, types: ReadonlySet<string>): HdlSyntaxNode | undefined {
    if (types.has(node.type)) {
        return node;
    }
    return descendants(node, candidate => types.has(candidate.type))[0];
}

function directChild(node: HdlSyntaxNode, ...types: string[]): HdlSyntaxNode | undefined {
    return node.namedChildren.find(child => types.includes(child.type));
}

function identifierChildren(node: HdlSyntaxNode): HdlSyntaxNode[] {
    return node.namedChildren.filter(child => identifierTypes.has(child.type));
}

function separatorSpan(current: HdlSyntaxNode, next: HdlSyntaxNode | undefined, context: AdaptContext): SourceSpan | undefined {
    return next
        ? sourceSpan(offsetSpan(current.endIndex, next.startIndex), context)
        : undefined;
}

function packedDimensions(node: HdlSyntaxNode, beforeIndex = node.endIndex): HdlSyntaxNode[] {
    const type = firstDescendant(node, new Set(['data_type', 'implicit_data_type']));
    if (!type) {
        return [];
    }
    return descendants(type, candidate => {
        if (candidate.type !== 'packed_dimension' || candidate.endIndex > beforeIndex) {
            return false;
        }
        let owner = candidate.parent;
        while (owner && owner.startIndex >= type.startIndex && owner.endIndex <= type.endIndex) {
            if (owner.type === 'data_type' || owner.type === 'implicit_data_type') {
                return owner.startIndex === type.startIndex && owner.endIndex === type.endIndex;
            }
            owner = owner.parent;
        }
        return false;
    }).sort((left, right) => left.startIndex - right.startIndex);
}

function typeNode(node: HdlSyntaxNode): HdlSyntaxNode | undefined {
    return firstDescendant(
        node,
        new Set(['data_type', 'implicit_data_type', 'net_type', 'interface_port_header'])
    );
}

function sourceText(range: ByteRange, context: AdaptContext): string {
    const span = sourceSpan(range, context);
    const owningText = span.uri === undefined || span.compositeParts
        ? undefined
        : context.sourceTexts[span.uri];
    return owningText === undefined
        ? context.transformedText.slice(range.startIndex, range.endIndex)
        : owningText.slice(span.start, span.end);
}

function packedRangeText(dimensions: HdlSyntaxNode[], context: AdaptContext): string | undefined {
    const first = dimensions[0];
    const last = dimensions[dimensions.length - 1];
    return first && last
        ? sourceText(offsetSpan(first.startIndex, last.endIndex), context)
        : undefined;
}

function packedRangeSpan(dimensions: HdlSyntaxNode[], context: AdaptContext): SourceSpan | undefined {
    const first = dimensions[0];
    const last = dimensions[dimensions.length - 1];
    return first && last
        ? sourceSpan(offsetSpan(first.startIndex, last.endIndex), context)
        : undefined;
}

function textWithoutRanges(node: HdlSyntaxNode | undefined, ranges: HdlSyntaxNode[], context: AdaptContext): string {
    if (!node) {
        return '';
    }
    const contained = ranges.filter(range =>
        range.startIndex >= node.startIndex && range.endIndex <= node.endIndex
    );
    if (contained.length === 0) {
        return node.text.trim();
    }
    let text = '';
    let offset = node.startIndex;
    for (const range of contained) {
        text += sourceText(offsetSpan(offset, range.startIndex), context);
        offset = range.endIndex;
    }
    text += sourceText(offsetSpan(offset, node.endIndex), context);
    return text.trim();
}

function simpleInteger(text: string): number | undefined {
    const normalized = text.split('_').join('').trim();
    return /^[0-9]+$/.test(normalized) ? Number(normalized) : undefined;
}

function baseTypeWidth(node: HdlSyntaxNode): number | undefined {
    const type = firstDescendant(node, new Set(['data_type', 'implicit_data_type']));
    if (!type || type.type === 'implicit_data_type') {
        return 1;
    }
    const vectorType = directChild(type, 'integer_vector_type');
    if (vectorType) {
        switch (vectorType.text.trim()) {
            case 'bit':
            case 'logic':
            case 'reg':
                return 1;
            default:
                return undefined;
        }
    }
    const atomType = directChild(type, 'integer_atom_type');
    if (atomType) {
        switch (atomType.text.trim()) {
            case 'byte':
                return 8;
            case 'shortint':
                return 16;
            case 'int':
            case 'integer':
                return 32;
            case 'longint':
            case 'time':
                return 64;
            default:
                return undefined;
        }
    }
    return undefined;
}

function widthFromDimensions(
    node: HdlSyntaxNode,
    dimensions: HdlSyntaxNode[],
    rangeText: string | undefined
): WidthValue {
    const baseBits = baseTypeWidth(node);
    if (baseBits === undefined) {
        return { kind: 'unknown' };
    }
    if (dimensions.length === 0) {
        return { kind: 'known', bits: baseBits };
    }
    let bits = baseBits;
    for (const dimension of dimensions) {
        const constantRange = firstDescendant(dimension, new Set(['constant_range']));
        const bounds = constantRange?.namedChildren.filter(
            child => child.type === 'constant_expression'
        ) ?? [];
        if (bounds.length !== 2) {
            return rangeText
                ? { kind: 'symbolic', expression: rangeText }
                : { kind: 'unknown' };
        }
        const left = simpleInteger(bounds[0].text);
        const right = simpleInteger(bounds[1].text);
        if (left !== undefined && right !== undefined) {
            bits *= Math.abs(left - right) + 1;
            if (!Number.isSafeInteger(bits)) {
                return { kind: 'unknown' };
            }
        } else {
            return rangeText
                ? { kind: 'symbolic', expression: rangeText }
                : { kind: 'unknown' };
        }
    }
    return { kind: 'known', bits };
}

function hasDescendant(node: HdlSyntaxNode, predicate: (candidate: HdlSyntaxNode) => boolean): boolean {
    return predicate(node) || descendants(node, predicate).length > 0;
}

function expressionWidth(node: HdlSyntaxNode, kind: ExpressionModel['kind']): WidthValue {
    if (kind === 'constant') {
        const sized = node.text.match(/^([0-9][0-9_]*)\s*'/);
        if (sized) {
            return { kind: 'known', bits: Number(sized[1].split('_').join('')) };
        }
        return { kind: 'unknown' };
    }
    if (kind === 'identifier' || kind === 'select' || kind === 'operation') {
        return { kind: 'symbolic', expression: node.text };
    }
    return { kind: 'unknown' };
}

const operationNodeTypes = new Set([
    'binary_expression',
    'unary_expression',
    'conditional_expression',
    'operator',
]);

const transparentExpressionTypes = new Set([
    'expression',
    'constant_expression',
    'constant_param_expression',
    'mintypmax_expression',
    'constant_mintypmax_expression',
    'primary',
    'constant_primary',
    'net_lvalue',
    'variable_lvalue',
]);

function isOperationNode(node: HdlSyntaxNode): boolean {
    return operationNodeTypes.has(node.type)
        || node.type.endsWith('_operator')
        || (node.childForFieldName('left') !== null
            && node.childForFieldName('right') !== null)
        || node.childForFieldName('operator') !== null;
}

function outerExpressionKind(node: HdlSyntaxNode): ExpressionModel['kind'] | undefined {
    let current: HdlSyntaxNode | undefined = node;
    while (current) {
        if (isOperationNode(current)) {
            return 'operation';
        }
        if (current.type.includes('concatenation')) {
            return 'concat';
        }
        if (current.type.includes('select') || current.type.includes('part_select')) {
            return 'select';
        }
        const directSelect = current.namedChildren.some(child =>
            child.type.includes('select') || child.type.includes('part_select')
        );
        if (directSelect) {
            return 'select';
        }
        if (current.namedChildren.some(child => child.type.includes('concatenation'))) {
            return 'concat';
        }
        if (!transparentExpressionTypes.has(current.type)
            || current.namedChildren.length !== 1) {
            return undefined;
        }
        current = current.namedChildren[0];
    }
    return undefined;
}

function adaptExpression(node: HdlSyntaxNode, context: AdaptContext): ExpressionModel {
    const hasConstant = hasDescendant(node, candidate =>
        candidate.type.includes('number')
        || candidate.type === 'unbased_unsized_literal'
        || candidate.type === 'string_literal'
        || candidate.type === 'time_literal'
    );
    const identifiers = descendants(node, candidate => identifierTypes.has(candidate.type));
    if (identifierTypes.has(node.type)) {
        identifiers.unshift(node);
    }

    let kind: ExpressionModel['kind'] = 'unknown';
    const outerKind = outerExpressionKind(node);
    if (outerKind) {
        kind = outerKind;
    } else if (hasConstant && identifiers.length === 0) {
        kind = 'constant';
    } else if (identifiers.length === 1 && !hasConstant) {
        kind = 'identifier';
    }

    return {
        kind,
        text: node.text,
        span: sourceSpan(node, context),
        width: expressionWidth(node, kind),
    };
}

function hasScopeQualifierBefore(node: HdlSyntaxNode, offset: number): boolean {
    return descendants(node, child =>
        (child.type === 'package_scope' || child.type === 'class_scope')
        && child.endIndex <= offset
    ).length > 0;
}

function isScopeResolutionPart(node: HdlSyntaxNode, ancestors: HdlSyntaxNode[]): boolean {
    for (let index = 0; index < ancestors.length; index++) {
        const methodCall = ancestors[index];
        if (methodCall.type !== 'method_call'
            || !methodCall.children.some(child => child.type === '::')) {
            continue;
        }
        const branch = ancestors[index + 1];
        if (branch?.type === 'primary') {
            return true;
        }
        if (branch?.type === 'method_call_body') {
            const name = branch.childForFieldName('name');
            if (name
                && name.startIndex === node.startIndex
                && name.endIndex === node.endIndex) {
                return true;
            }
        }
    }
    return false;
}

function sameSyntaxNode(left: HdlSyntaxNode | null, right: HdlSyntaxNode): boolean {
    return left !== null
        && left.startIndex === right.startIndex
        && left.endIndex === right.endIndex
        && left.type === right.type;
}

function identifierCanBind(node: HdlSyntaxNode, ancestors: HdlSyntaxNode[]): boolean {
    if (ancestors.some(ancestor => ancestor.type === 'text_macro_usage')) {
        return false;
    }
    if (isScopeResolutionPart(node, ancestors)) {
        return false;
    }
    const namedDeclarationTypes = new Set([
        'variable_decl_assignment',
        'type_assignment',
        'tf_port_item',
    ]);
    const directDeclarationTypes = new Set([
        'param_assignment',
        'for_variable_declaration',
        'loop_variables',
        'list_of_tf_variable_identifiers',
        'enum_name_declaration',
        'list_of_arguments',
    ]);
    for (let index = ancestors.length - 1; index >= 0; index--) {
        const current = ancestors[index];
        if (namedDeclarationTypes.has(current.type)
            && sameSyntaxNode(current.childForFieldName('name'), node)) {
            return false;
        }
        if (directDeclarationTypes.has(current.type)
            && identifierChildren(current).some(identifier => sameSyntaxNode(identifier, node))) {
            return false;
        }
        if ((current.type === 'seq_block' || current.type === 'par_block')
            && identifierChildren(current).some(identifier => sameSyntaxNode(identifier, node))) {
            return false;
        }
        if (current.type === 'statement'
            && sameSyntaxNode(current.childForFieldName('block_name'), node)) {
            return false;
        }
        if (current.type === 'type_declaration'
            && sameSyntaxNode(current.childForFieldName('type_name'), node)) {
            return false;
        }
        if ((current.type === 'data_type' || current.type === 'class_type')
            && identifierChildren(current).some(identifier => sameSyntaxNode(identifier, node))) {
            return false;
        }
    }
    for (let index = ancestors.length - 1; index >= 0; index--) {
        const current = ancestors[index];
        if (current.type === 'text_macro_usage'
            || current.type === 'package_scope'
            || current.type === 'class_scope') {
            return false;
        }
        if (current.type === 'hierarchical_identifier') {
            const directIdentifiers = current.namedChildren.filter(child =>
                identifierTypes.has(child.type) || child.type === 'text_macro_usage'
            );
            const first = directIdentifiers[0];
            let qualified = false;
            for (let parentIndex = index - 1; parentIndex >= 0; parentIndex--) {
                const container = ancestors[parentIndex];
                if (container.type === 'primary'
                    || container.type === 'constant_primary'
                    || container.type === 'net_lvalue'
                    || container.type === 'variable_lvalue') {
                    qualified = hasScopeQualifierBefore(container, current.startIndex);
                    break;
                }
            }
            return first !== undefined
                && first.startIndex === node.startIndex
                && first.endIndex === node.endIndex
                && !qualified;
        }
        if (current.type === 'primary'
            || current.type === 'constant_primary'
            || current.type === 'net_lvalue'
            || current.type === 'variable_lvalue') {
            return !hasScopeQualifierBefore(current, node.startIndex);
        }
    }
    return true;
}

function referenceNodes(node: HdlSyntaxNode): ReferenceCandidate[] {
    const references: ReferenceCandidate[] = [];
    const visit = (candidate: HdlSyntaxNode, ancestors: HdlSyntaxNode[]): void => {
        if (identifierTypes.has(candidate.type)) {
            references.push({
                node: candidate,
                bindingEligible: identifierCanBind(candidate, ancestors),
            });
        }
        for (const child of candidate.namedChildren) {
            visit(child, [...ancestors, candidate]);
        }
    };
    visit(node, []);
    return references;
}

function adaptParameterDeclaration(
    declaration: HdlSyntaxNode,
    kind: ParameterModel['kind'],
    context: AdaptContext
): ParameterModel[] {
    const typeDeclaration = declaration.type === 'type_parameter_declaration'
        ? declaration
        : firstDescendant(declaration, new Set(['type_parameter_declaration']));
    const typeAssignments = typeDeclaration
        ? directChild(typeDeclaration, 'list_of_type_assignments')
        : undefined;
    if (typeAssignments) {
        return typeAssignments.namedChildren
            .filter(child => child.type === 'type_assignment')
            .flatMap(assignment => {
                const nameNode = assignment.childForFieldName('name')
                    ?? identifierChildren(assignment)[0];
                if (!nameNode) {
                    return [];
                }
                const valueNode = assignment.childForFieldName('value');
                return [{
                    id: stableId(kind, nameNode.text, nameNode.startIndex, context.request.uri),
                    name: nameNode.text,
                    kind,
                    typeText: 'type',
                    defaultExpression: valueNode?.text,
                    defaultValue: valueNode ? {
                        kind: 'unknown' as const,
                        text: valueNode.text,
                        span: sourceSpan(valueNode, context),
                        width: { kind: 'unknown' as const },
                    } : undefined,
                    declarationSpan: sourceSpan(declaration, context),
                    nameSpan: sourceSpan(nameNode, context),
                    valueSpan: valueNode ? sourceSpan(valueNode, context) : undefined,
                }];
            });
    }
    const list = declaration.type === 'list_of_param_assignments'
        ? declaration
        : directChild(declaration, 'list_of_param_assignments');
    if (!list) {
        return [];
    }
    const dimensions = packedDimensions(declaration, list.startIndex);
    const declarationType = textWithoutRanges(typeNode(declaration), dimensions, context);
    return list.namedChildren
        .filter(child => child.type === 'param_assignment')
        .flatMap(assignment => {
            const nameNode = identifierChildren(assignment)[0];
            if (!nameNode) {
                return [];
            }
            const valueNode = assignment.namedChildren.find(child =>
                child.type === 'constant_param_expression'
            );
            return [{
                id: stableId(kind, nameNode.text, nameNode.startIndex, context.request.uri),
                name: nameNode.text,
                kind,
                typeText: declarationType,
                defaultExpression: valueNode?.text,
                defaultValue: valueNode ? adaptExpression(valueNode, context) : undefined,
                declarationSpan: sourceSpan(declaration, context),
                nameSpan: sourceSpan(nameNode, context),
                valueSpan: valueNode ? sourceSpan(valueNode, context) : undefined,
            }];
        });
}

function adaptParameters(
    header: HdlSyntaxNode,
    scopeItems: HdlSyntaxNode[],
    context: AdaptContext
): { parameters: ParameterModel[]; localParameters: ParameterModel[] } {
    const parameters: ParameterModel[] = [];
    const localParameters: ParameterModel[] = [];
    const parameterPortList = directChild(header, 'parameter_port_list');
    const headerCandidates = parameterPortList
        ? parameterPortList.namedChildren.flatMap(declaration => {
            if (declaration.type === 'parameter_port_declaration') {
                return [
                    directChild(
                        declaration,
                        'parameter_declaration',
                        'local_parameter_declaration'
                    ) ?? declaration,
                ];
            }
            return declaration.type === 'list_of_param_assignments'
                ? [declaration]
                : [];
        })
        : [];
    const candidates = [
        ...headerCandidates,
        ...scopeItems.flatMap(item => {
            if (item.type === 'parameter_declaration' || item.type === 'local_parameter_declaration') {
                return [item];
            }
            return item.namedChildren.filter(child =>
                child.type === 'parameter_declaration'
                || child.type === 'local_parameter_declaration'
            );
        }),
    ];

    const seen = new Set<number>();
    for (const declaration of candidates) {
        if (seen.has(declaration.startIndex)) {
            continue;
        }
        seen.add(declaration.startIndex);
        const kind = declaration.type === 'local_parameter_declaration'
            ? 'localparam'
            : 'parameter';
        const adapted = adaptParameterDeclaration(declaration, kind, context);
        (kind === 'parameter' ? parameters : localParameters).push(...adapted);
    }
    return { parameters, localParameters };
}

type PortPrefix = {
    direction: PortModel['direction'];
    typeText: string;
    packedRange?: string;
    width: WidthValue;
};

function directionFromNode(node: HdlSyntaxNode | undefined): PortModel['direction'] | undefined {
    if (!node) {
        return undefined;
    }
    const direction = firstDescendant(node, new Set(['port_direction']));
    const text = direction?.text ?? node.children.find(child =>
        child.type === 'input' || child.type === 'output' || child.type === 'inout'
    )?.type;
    return text === 'input' || text === 'output' || text === 'inout' ? text : undefined;
}

function adaptAnsiPorts(
    header: HdlSyntaxNode,
    context: AdaptContext,
    diagnostics: HdlDiagnostic[]
): { ports: PortModel[]; groups: PortDeclarationGroupModel[] } {
    const list = directChild(header, 'list_of_port_declarations');
    if (!list) {
        return { ports: [], groups: [] };
    }
    const declarations = list.namedChildren.filter(child => child.type === 'ansi_port_declaration');
    const ports: PortModel[] = [];
    const groups: PortDeclarationGroupModel[] = [];
    let inherited: PortPrefix | undefined;
    let inheritsUnsupportedInterface = false;
    let currentGroup: PortDeclarationGroupModel | undefined;
    let currentGroupStartIndex: number | undefined;
    const reportUnsupportedInterface = (declaration: HdlSyntaxNode): void => {
        diagnostics.push({
            severity: 'warning',
            code: 'systemverilog.unsupported-interface-port',
            message: 'Interface and modport ports are not supported in the structural model',
            span: sourceSpan(declaration, context),
        });
    };

    for (let index = 0; index < declarations.length; index++) {
        const declaration = declarations[index];
        const nameNode = declaration.childForFieldName('port_name');
        if (!nameNode) {
            continue;
        }
        const explicitHeader = directChild(
            declaration,
            'net_port_header',
            'variable_port_header',
            'interface_port_header',
            'port_direction'
        );
        const explicitDirection = directionFromNode(explicitHeader);
        if (explicitHeader?.type === 'interface_port_header' && !explicitDirection) {
            reportUnsupportedInterface(declaration);
            inherited = undefined;
            inheritsUnsupportedInterface = true;
            currentGroup = undefined;
            currentGroupStartIndex = undefined;
            continue;
        }
        if (!explicitHeader && inheritsUnsupportedInterface) {
            reportUnsupportedInterface(declaration);
            currentGroup = undefined;
            currentGroupStartIndex = undefined;
            continue;
        }
        inheritsUnsupportedInterface = false;
        const dimensions = explicitHeader
            ? packedDimensions(explicitHeader, nameNode.startIndex)
            : [];
        const rangeText = packedRangeText(dimensions, context);
        const prefix: PortPrefix = explicitHeader
            ? {
                direction: explicitDirection ?? inherited?.direction ?? 'input',
                typeText: textWithoutRanges(typeNode(explicitHeader), dimensions, context),
                packedRange: rangeText,
                width: widthFromDimensions(explicitHeader, dimensions, rangeText),
            }
            : inherited ?? {
                direction: 'input',
                typeText: '',
                width: { kind: 'known', bits: 1 },
            };

        if (explicitHeader || !currentGroup) {
            const groupId = stableId('port-group', nameNode.text, declaration.startIndex, context.request.uri);
            currentGroup = {
                id: groupId,
                style: 'ansi',
                declarationSpan: sourceSpan(declaration, context),
                sharedPrefixSpan: explicitHeader
                    ? sourceSpan(explicitHeader, context)
                    : sourceSpan(offsetSpan(nameNode.startIndex, nameNode.startIndex), context),
                items: [],
            };
            groups.push(currentGroup);
            currentGroupStartIndex = declaration.startIndex;
        }

        const portId = stableId('port', nameNode.text, nameNode.startIndex, context.request.uri);
        const nextDeclaration = declarations[index + 1];
        const nextHasExplicitHeader = nextDeclaration
            ? directChild(
                nextDeclaration,
                'net_port_header',
                'variable_port_header',
                'interface_port_header',
                'port_direction'
            ) !== undefined
            : false;
        currentGroup.items.push({
            portId,
            itemSpan: sourceSpan(declaration, context),
            separatorSpan: nextDeclaration && !nextHasExplicitHeader
                ? separatorSpan(declaration, nextDeclaration, context)
                : undefined,
        });
        currentGroup.declarationSpan = sourceSpan(
            offsetSpan(currentGroupStartIndex!, declaration.endIndex),
            context
        );

        const directionNode = explicitHeader
            ? firstDescendant(explicitHeader, new Set(['port_direction']))
                ?? explicitHeader.children.find(child => child.type === prefix.direction)
            : undefined;
        ports.push({
            id: portId,
            name: nameNode.text,
            direction: prefix.direction,
            typeText: prefix.typeText,
            packedRange: prefix.packedRange,
            width: prefix.width,
            declarationSpan: currentGroup.declarationSpan,
            directionSpan: directionNode ? sourceSpan(directionNode, context) : undefined,
            nameSpan: sourceSpan(nameNode, context),
            headerItemSpan: sourceSpan(declaration, context),
            headerNameSpan: sourceSpan(nameNode, context),
            packedRangeSpan: packedRangeSpan(dimensions, context),
            declarationGroupId: currentGroup.id,
            inheritsDirection: !explicitHeader && inherited !== undefined,
            inheritsType: !explicitHeader && inherited !== undefined,
            inheritsPackedRange: !explicitHeader && inherited?.packedRange !== undefined,
        });
        inherited = prefix;
    }

    for (const group of groups) {
        const groupPorts = ports.filter(port => port.declarationGroupId === group.id);
        for (const port of groupPorts) {
            port.declarationSpan = group.declarationSpan;
        }
    }
    return { ports, groups };
}

function unwrapPortDeclaration(item: HdlSyntaxNode): { wrapper: HdlSyntaxNode; declaration: HdlSyntaxNode } | undefined {
    const portDeclaration = item.type === 'port_declaration'
        ? item
        : directChild(item, 'port_declaration');
    const declaration = portDeclaration?.namedChildren.find(child =>
        child.type === 'input_declaration'
        || child.type === 'output_declaration'
        || child.type === 'inout_declaration'
    );
    return declaration && portDeclaration ? { wrapper: item, declaration } : undefined;
}

function adaptNonAnsiPorts(
    header: HdlSyntaxNode,
    scopeItems: HdlSyntaxNode[],
    context: AdaptContext
): { ports: PortModel[]; groups: PortDeclarationGroupModel[] } {
    const list = directChild(header, 'list_of_ports');
    if (!list) {
        return { ports: [], groups: [] };
    }
    const ports: PortModel[] = list.namedChildren
        .filter(child => child.type === 'port')
        .flatMap(item => {
            const nameNode = firstDescendant(item, identifierTypes);
            if (!nameNode) {
                return [];
            }
            const id = stableId('port', nameNode.text, nameNode.startIndex, context.request.uri);
            return [{
                id,
                name: nameNode.text,
                direction: 'input' as const,
                typeText: '',
                width: { kind: 'known' as const, bits: 1 },
                declarationSpan: sourceSpan(item, context),
                nameSpan: sourceSpan(nameNode, context),
                headerItemSpan: sourceSpan(item, context),
                headerNameSpan: sourceSpan(nameNode, context),
                declarationGroupId: stableId('port-group', nameNode.text, item.startIndex, context.request.uri),
                inheritsDirection: false,
                inheritsType: false,
                inheritsPackedRange: false,
            }];
        });
    const portByName = new Map(ports.map(port => [port.name, port]));
    const groups: PortDeclarationGroupModel[] = [];

    for (const item of scopeItems) {
        const unwrapped = unwrapPortDeclaration(item);
        if (!unwrapped) {
            continue;
        }
        const { wrapper, declaration } = unwrapped;
        const direction = directionFromNode(declaration) ?? 'input';
        const listNode = directChild(
            declaration,
            'list_of_port_identifiers',
            'list_of_variable_identifiers'
        );
        const names = listNode ? identifierChildren(listNode) : [];
        if (names.length === 0) {
            continue;
        }
        const dimensions = packedDimensions(declaration, names[0].startIndex);
        const rangeText = packedRangeText(dimensions, context);
        const groupId = stableId('port-group', names[0].text, declaration.startIndex, context.request.uri);
        const group: PortDeclarationGroupModel = {
            id: groupId,
            style: 'non-ansi',
            declarationSpan: sourceSpan(wrapper, context),
            sharedPrefixSpan: sourceSpan(
                offsetSpan(declaration.startIndex, names[0].startIndex),
                context
            ),
            items: names.map((name, index) => ({
                portId: portByName.get(name.text)?.id
                    ?? stableId('port', name.text, name.startIndex, context.request.uri),
                itemSpan: sourceSpan(name, context),
                separatorSpan: separatorSpan(name, names[index + 1], context),
            })),
        };
        groups.push(group);

        const declarationType = textWithoutRanges(typeNode(declaration), dimensions, context);
        names.forEach((nameNode, index) => {
            const port = portByName.get(nameNode.text);
            if (!port) {
                return;
            }
            port.direction = direction;
            port.typeText = declarationType;
            port.packedRange = rangeText;
            port.width = widthFromDimensions(declaration, dimensions, rangeText);
            port.declarationSpan = sourceSpan(wrapper, context);
            const directionNode = declaration.children.find(child => child.type === direction);
            port.directionSpan = index === 0 && directionNode
                ? sourceSpan(directionNode, context)
                : undefined;
            port.nameSpan = sourceSpan(nameNode, context);
            port.bodyDeclarationSpan = sourceSpan(wrapper, context);
            port.bodyNameSpan = sourceSpan(nameNode, context);
            port.packedRangeSpan = index === 0
                ? packedRangeSpan(dimensions, context)
                : undefined;
            port.declarationGroupId = groupId;
            port.inheritsDirection = index > 0;
            port.inheritsType = index > 0;
            port.inheritsPackedRange = index > 0 && dimensions.length > 0;
        });
    }
    return { ports, groups };
}

function emptyExpressionSpan(connection: HdlSyntaxNode, context: AdaptContext): SourceSpan {
    const leftParen = connection.children.find(child => child.type === '(');
    const insertion = leftParen?.endIndex ?? connection.endIndex;
    return sourceSpan(offsetSpan(insertion, insertion), context);
}

function adaptNamedConnection(
    connection: HdlSyntaxNode,
    context: AdaptContext
): { model: InstanceConnectionModel; expressionNode?: HdlSyntaxNode } {
    if (connection.text === '.*') {
        const wildcard = offsetSpan(connection.endIndex - 1, connection.endIndex);
        return {
            model: {
                expression: '*',
                expressionSpan: sourceSpan(wildcard, context),
                connectionSpan: sourceSpan(connection, context),
                syntax: 'wildcard',
            },
        };
    }
    const nameNode = connection.childForFieldName('port_name')
        ?? identifierChildren(connection)[0];
    const expressionNode = connection.childForFieldName('connection')
        ?? connection.namedChildren.find(child =>
            child.type === 'param_expression' || child.type === 'expression'
        );
    const hasParentheses = connection.children.some(child => child.type === '(');
    if (!expressionNode && !hasParentheses && nameNode) {
        const expressionModel = adaptExpression(nameNode, context);
        return {
            model: {
                name: nameNode.text,
                expression: nameNode.text,
                expressionSpan: sourceSpan(nameNode, context),
                expressionModel,
                connectionSpan: sourceSpan(connection, context),
                nameSpan: sourceSpan(nameNode, context),
                syntax: 'implicit',
            },
            expressionNode: nameNode,
        };
    }
    const span = expressionNode
        ? sourceSpan(expressionNode, context)
        : emptyExpressionSpan(connection, context);
    return {
        model: {
            name: nameNode?.text,
            expression: expressionNode?.text ?? '',
            expressionSpan: span,
            expressionModel: expressionNode ? adaptExpression(expressionNode, context) : undefined,
            connectionSpan: sourceSpan(connection, context),
            nameSpan: nameNode ? sourceSpan(nameNode, context) : undefined,
            syntax: 'named',
        },
        expressionNode,
    };
}

function adaptConnectionList(
    list: HdlSyntaxNode | undefined,
    context: AdaptContext
): { models: InstanceConnectionModel[]; expressionNodes: HdlSyntaxNode[] } {
    if (!list) {
        return { models: [], expressionNodes: [] };
    }
    const models: InstanceConnectionModel[] = [];
    const expressionNodes: HdlSyntaxNode[] = [];
    const parent = list.parent;
    const leftParens = parent?.children
        .filter(child => child.type === '(' && child.endIndex <= list.startIndex) ?? [];
    const leftParen = leftParens[leftParens.length - 1];
    const rightParen = parent?.children.find(child =>
        child.type === ')' && child.startIndex >= list.endIndex
    );
    const interiorStart = leftParen?.endIndex ?? list.startIndex;
    const interiorEnd = rightParen?.startIndex ?? list.endIndex;
    const commas = list.children.filter(child => child.type === ',');
    const connectionTypes = new Set([
        'named_port_connection',
        'named_parameter_assignment',
        'ordered_port_connection',
        'ordered_parameter_assignment',
    ]);
    const connections = [
        ...list.namedChildren.filter(child => connectionTypes.has(child.type)),
        ...(parent?.namedChildren.filter(child =>
            child.type === 'ERROR'
            && child.startIndex >= interiorStart
            && child.endIndex <= interiorEnd
        ) ?? []),
    ].sort((left, right) => left.startIndex - right.startIndex);
    const segments = commas.length > 0
        ? commas.map((comma, index) => ({
            start: index === 0 ? interiorStart : commas[index - 1].endIndex,
            end: comma.startIndex,
            insertion: index === 0 ? interiorStart : commas[index - 1].endIndex,
        })).concat([{
            start: commas[commas.length - 1].endIndex,
            end: interiorEnd,
            insertion: commas[commas.length - 1].endIndex,
        }])
        : connections.map(connection => ({
            start: connection.startIndex,
            end: connection.endIndex,
            insertion: connection.startIndex,
        }));

    for (const segment of segments) {
        const connection = connections.find(candidate =>
            candidate.startIndex >= segment.start && candidate.endIndex <= segment.end
        );
        if (!connection) {
            const span = sourceSpan(offsetSpan(segment.insertion, segment.insertion), context);
            models.push({
                expression: '',
                expressionSpan: span,
                connectionSpan: span,
                syntax: 'positional',
            });
            continue;
        }
        if (connection.type === 'named_port_connection'
            || connection.type === 'named_parameter_assignment') {
            const adapted = adaptNamedConnection(connection, context);
            models.push(adapted.model);
            if (adapted.expressionNode) {
                expressionNodes.push(adapted.expressionNode);
            }
        } else {
            const expressionNode = connection.type === 'ERROR'
                ? connection
                : connection.namedChildren[0];
            if (expressionNode) {
                models.push({
                    expression: expressionNode.text,
                    expressionSpan: sourceSpan(expressionNode, context),
                    expressionModel: adaptExpression(expressionNode, context),
                    connectionSpan: sourceSpan(connection, context),
                    syntax: 'positional',
                });
                expressionNodes.push(expressionNode);
            }
        }
    }
    return { models, expressionNodes };
}

function instanceSyntax(connections: InstanceConnectionModel[]): InstanceModel['syntax'] {
    const syntaxes = new Set(connections.map(connection => connection.syntax));
    if (syntaxes.size === 0) {
        return 'positional';
    }
    return syntaxes.size === 1
        ? connections[0].syntax
        : 'mixed';
}

function adaptInstance(
    statement: HdlSyntaxNode,
    context: AdaptContext
): {
    instances: InstanceModel[];
    group?: InstanceDeclarationGroupModel;
    referenceNodes: HdlSyntaxNode[];
} {
    const moduleName = statement.childForFieldName('instance_type');
    if (!moduleName) {
        return { instances: [], referenceNodes: [] };
    }
    const parameterBlock = directChild(statement, 'parameter_value_assignment');
    const parameterList = parameterBlock
        ? directChild(parameterBlock, 'list_of_parameter_value_assignments')
        : undefined;
    const parameters = adaptConnectionList(parameterList, context);
    const items = statement.namedChildren.filter(child =>
        child.type === 'hierarchical_instance' || child.type === 'udp_instance'
    );
    const groupId = stableId('instance-group', moduleName.text, statement.startIndex, context.request.uri);
    const instances: InstanceModel[] = [];
    const referenceNodes = [...parameters.expressionNodes];

    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const nameOfInstance = directChild(item, 'name_of_instance');
        const nameNode = nameOfInstance?.childForFieldName('instance_name');
        if (!nameNode) {
            continue;
        }
        const portList = directChild(item, 'list_of_port_connections');
        const ports = portList
            ? adaptConnectionList(portList, context)
            : adaptUdpTerminals(item, context);
        referenceNodes.push(...ports.expressionNodes);
        instances.push({
            id: stableId('instance', nameNode.text, nameNode.startIndex, context.request.uri),
            moduleName: moduleName.text,
            instanceName: nameNode.text,
            syntax: instanceSyntax(ports.models),
            declarationSpan: sourceSpan(statement, context),
            declarationGroupId: groupId,
            itemSpan: sourceSpan(item, context),
            separatorSpan: separatorSpan(item, items[index + 1], context),
            moduleNameSpan: sourceSpan(moduleName, context),
            nameSpan: sourceSpan(nameNode, context),
            parameterConnections: parameters.models,
            portConnections: ports.models,
        });
    }
    return {
        instances,
        group: {
            id: groupId,
            statementSpan: sourceSpan(statement, context),
            moduleNameSpan: sourceSpan(moduleName, context),
            parameterBlockSpan: parameterBlock ? sourceSpan(parameterBlock, context) : undefined,
            items: instances.map(instance => ({
                instanceId: instance.id,
                itemSpan: instance.itemSpan,
                separatorSpan: instance.separatorSpan,
            })),
        },
        referenceNodes,
    };
}

function adaptUdpTerminals(
    item: HdlSyntaxNode,
    context: AdaptContext
): { models: InstanceConnectionModel[]; expressionNodes: HdlSyntaxNode[] } {
    const models: InstanceConnectionModel[] = [];
    const expressionNodes: HdlSyntaxNode[] = [];
    for (const terminal of item.namedChildren.filter(child =>
        child.type === 'output_terminal'
        || child.type === 'input_terminal'
        || child.type === 'inout_terminal'
    )) {
        const expressionNode = terminal.namedChildren[0];
        if (!expressionNode) {
            continue;
        }
        models.push({
            expression: expressionNode.text,
            expressionSpan: sourceSpan(expressionNode, context),
            expressionModel: adaptExpression(expressionNode, context),
            connectionSpan: sourceSpan(terminal, context),
            syntax: 'positional',
        });
        expressionNodes.push(expressionNode);
    }
    return { models, expressionNodes };
}

function adaptNetDeclaration(node: HdlSyntaxNode, context: AdaptContext): NetDeclarationModel | undefined {
    const isNet = node.type === 'net_declaration';
    const list = directChild(
        node,
        isNet ? 'list_of_net_decl_assignments' : 'list_of_variable_decl_assignments'
    );
    if (!list) {
        return undefined;
    }
    const assignments = list.namedChildren.filter(child =>
        child.type === (isNet ? 'net_decl_assignment' : 'variable_decl_assignment')
    );
    const names = assignments.flatMap(assignment => {
        const name = isNet
            ? identifierChildren(assignment)[0]
            : assignment.childForFieldName('name');
        return name ? [{ name: name.text, nameSpan: sourceSpan(name, context) }] : [];
    });
    if (names.length === 0) {
        return undefined;
    }
    const dimensions = packedDimensions(node, list.startIndex);
    const rangeText = packedRangeText(dimensions, context);
    const vectorType = firstDescendant(node, new Set(['integer_vector_type']))?.text;
    const netType = directChild(node, 'net_type')?.text;
    const kind: NetDeclarationModel['kind'] = isNet
        ? netType === 'wire' || netType === undefined ? 'wire' : 'other'
        : vectorType === 'logic' ? 'logic' : vectorType === 'reg' ? 'reg' : 'other';
    const dataType = firstDescendant(node, new Set(['data_type', 'implicit_data_type']));
    const baseType = textWithoutRanges(dataType, dimensions, context);
    const typeParts = [...new Set([netType, baseType].filter(
        (part): part is string => part !== undefined && part.length > 0
    ))];
    return {
        id: stableId('declaration', names[0].name, node.startIndex, context.request.uri),
        kind,
        typeText: typeParts.join(' '),
        names,
        declarationSpan: sourceSpan(node, context),
        packedRange: rangeText,
        width: widthFromDimensions(node, dimensions, rangeText),
    };
}

function adaptContinuousAssign(
    node: HdlSyntaxNode,
    context: AdaptContext
): { assignments: ContinuousAssignModel[]; references: Array<{ node: HdlSyntaxNode; context: PendingReference['context'] }> } {
    const list = directChild(node, 'list_of_net_assignments', 'list_of_variable_assignments');
    const assignments: ContinuousAssignModel[] = [];
    const references: Array<{ node: HdlSyntaxNode; context: PendingReference['context'] }> = [];
    for (const assignment of list?.namedChildren ?? []) {
        if (assignment.type !== 'net_assignment' && assignment.type !== 'variable_assignment') {
            continue;
        }
        const target = assignment.namedChildren.find(child =>
            child.type === 'net_lvalue' || child.type === 'variable_lvalue'
        );
        const value = assignment.namedChildren.find(child => child.type === 'expression');
        if (!target || !value) {
            continue;
        }
        assignments.push({
            id: stableId('assign', target.text, assignment.startIndex, context.request.uri),
            target: adaptExpression(target, context),
            value: adaptExpression(value, context),
            declarationSpan: sourceSpan(node, context),
        });
        references.push(
            { node: target, context: 'assignmentTarget' },
            { node: value, context: 'assignmentValue' }
        );
    }
    return { assignments, references };
}

function uniqueSpans(spans: SourceSpan[]): SourceSpan[] {
    const seen = new Set<string>();
    return spans.filter(span => {
        const key = `${span.uri}:${span.start}:${span.end}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    }).sort((left, right) => left.start - right.start);
}

function buildSymbols(
    module: ModuleModel,
    variableDeclarationIds: ReadonlySet<string>,
    context: AdaptContext
): ModuleSymbolModel[] {
    const symbols: ModuleSymbolModel[] = [];
    for (const parameter of [...module.parameters, ...module.localParameters]) {
        symbols.push({
            id: stableId('symbol-parameter', parameter.name, parameter.nameSpan.start, context.request.uri),
            name: parameter.name,
            kind: 'parameter',
            declarationSpans: [parameter.declarationSpan],
        });
    }
    for (const port of module.ports) {
        symbols.push({
            id: stableId('symbol-port', port.name, port.headerNameSpan.start, context.request.uri),
            name: port.name,
            kind: 'port',
            declarationSpans: uniqueSpans([
                port.headerItemSpan,
                ...(port.bodyDeclarationSpan ? [port.bodyDeclarationSpan] : []),
            ]),
        });
    }
    for (const net of module.nets) {
        for (const name of net.names) {
            const portSymbol = symbols.find(symbol =>
                symbol.kind === 'port' && symbol.name === name.name
            );
            if (portSymbol) {
                portSymbol.declarationSpans = uniqueSpans([
                    ...portSymbol.declarationSpans,
                    net.declarationSpan,
                ]);
                continue;
            }
            symbols.push({
                id: stableId(`symbol-${net.kind}`, name.name, name.nameSpan.start, context.request.uri),
                name: name.name,
                kind: variableDeclarationIds.has(net.id) ? 'variable' : 'net',
                declarationSpans: [net.declarationSpan],
            });
        }
    }
    for (const instance of module.instances) {
        symbols.push({
            id: stableId('symbol-instance', instance.instanceName, instance.nameSpan.start, context.request.uri),
            name: instance.instanceName,
            kind: 'instance',
            declarationSpans: [instance.itemSpan],
        });
    }
    return symbols.sort((left, right) =>
        left.declarationSpans[0].start - right.declarationSpans[0].start
    );
}

function bindReferences(
    pending: PendingReference[],
    symbols: ModuleSymbolModel[]
): SymbolReferenceModel[] {
    const byName = new Map<string, ModuleSymbolModel>();
    for (const symbol of symbols) {
        if (!byName.has(symbol.name)) {
            byName.set(symbol.name, symbol);
        }
    }
    return pending.map(reference => {
        const { bindingEligible, ...model } = reference;
        return {
            ...model,
            symbolId: bindingEligible ? byName.get(reference.name)?.id : undefined,
        };
    });
}

type LexicalBinding = {
    name: string;
    scope: HdlSyntaxNode;
};

const lexicalScopeTypes = new Set([
    'seq_block',
    'par_block',
    'function_body_declaration',
    'task_body_declaration',
    'loop_statement',
]);

function nearestLexicalScope(node: HdlSyntaxNode, opaque: HdlSyntaxNode): HdlSyntaxNode {
    let current = node.parent;
    while (current && current.startIndex >= opaque.startIndex && current.endIndex <= opaque.endIndex) {
        if (lexicalScopeTypes.has(current.type)) {
            return current;
        }
        current = current.parent;
    }
    return opaque;
}

function collectOpaqueBindings(opaque: HdlSyntaxNode): LexicalBinding[] {
    const bindings: LexicalBinding[] = [];
    const add = (name: HdlSyntaxNode, owner: HdlSyntaxNode): void => {
        bindings.push({ name: name.text, scope: nearestLexicalScope(owner, opaque) });
    };

    for (const declaration of descendants(opaque, candidate => candidate.type === 'data_declaration')) {
        const list = directChild(declaration, 'list_of_variable_decl_assignments');
        for (const assignment of list?.namedChildren ?? []) {
            const name = assignment.childForFieldName('name');
            if (name) {
                add(name, declaration);
            }
        }
    }
    for (const declaration of descendants(opaque, candidate =>
        candidate.type === 'parameter_declaration'
        || candidate.type === 'local_parameter_declaration'
    )) {
        for (const assignment of descendants(declaration, candidate =>
            candidate.type === 'param_assignment' || candidate.type === 'type_assignment'
        )) {
            const name = assignment.childForFieldName('name')
                ?? identifierChildren(assignment)[0];
            if (name) {
                add(name, declaration);
            }
        }
    }
    for (const declaration of descendants(opaque, candidate =>
        candidate.type === 'enum_name_declaration'
    )) {
        const name = identifierChildren(declaration)[0];
        if (name) {
            add(name, declaration);
        }
    }
    for (const declaration of descendants(opaque, candidate =>
        candidate.type === 'type_declaration'
    )) {
        const name = declaration.childForFieldName('type_name');
        if (name) {
            add(name, declaration);
        }
    }
    for (const port of descendants(opaque, candidate => candidate.type === 'tf_port_item')) {
        const name = port.childForFieldName('name');
        if (name) {
            add(name, port);
        }
    }
    for (const portList of descendants(
        opaque,
        candidate => candidate.type === 'list_of_tf_variable_identifiers'
    )) {
        for (const name of identifierChildren(portList)) {
            add(name, portList);
        }
    }
    for (const declaration of descendants(
        opaque,
        candidate => candidate.type === 'for_variable_declaration'
    )) {
        for (const name of identifierChildren(declaration)) {
            add(name, declaration);
        }
    }
    for (const loopVariables of descendants(
        opaque,
        candidate => candidate.type === 'loop_variables'
    )) {
        for (const name of identifierChildren(loopVariables)) {
            add(name, loopVariables);
        }
    }
    const body = firstDescendant(
        opaque,
        new Set(['function_body_declaration', 'task_body_declaration'])
    );
    const bodyName = body?.childForFieldName('name');
    if (body && bodyName) {
        add(bodyName, body);
    }
    return bindings;
}

function isShadowedAt(node: HdlSyntaxNode, bindings: LexicalBinding[]): boolean {
    return bindings.some(binding =>
        binding.name === node.text
        && node.startIndex >= binding.scope.startIndex
        && node.endIndex <= binding.scope.endIndex
    );
}

function adaptOpaqueRegions(
    items: HdlSyntaxNode[],
    symbols: ModuleSymbolModel[],
    context: AdaptContext
): { regions: OpaqueLogicModel[]; references: PendingReference[] } {
    const symbolNames = new Set(symbols.map(symbol => symbol.name));
    const regions: OpaqueLogicModel[] = [];
    const references: PendingReference[] = [];
    for (const item of items) {
        const opaque = opaqueTypes.has(item.type)
            ? item
            : item.namedChildren.find(child => opaqueTypes.has(child.type));
        if (!opaque) {
            continue;
        }
        const bindings = collectOpaqueBindings(opaque);
        const boundaryNames: string[] = [];
        for (const candidate of referenceNodes(opaque)) {
            const identifier = candidate.node;
            if (!symbolNames.has(identifier.text)
                || isShadowedAt(identifier, bindings)
                || !candidate.bindingEligible) {
                continue;
            }
            if (!boundaryNames.includes(identifier.text)) {
                boundaryNames.push(identifier.text);
            }
            references.push({
                name: identifier.text,
                span: sourceSpan(identifier, context),
                context: 'unknown',
                bindingEligible: true,
            });
        }
        regions.push({
            id: stableId('opaque', opaque.type, opaque.startIndex, context.request.uri),
            reason: opaque.type,
            span: sourceSpan(opaque, context),
            boundaryNames,
        });
    }
    return { regions, references };
}

function scopeItems(module: HdlSyntaxNode, header: HdlSyntaxNode): HdlSyntaxNode[] {
    return module.namedChildren.filter(child =>
        child !== header
        && child.type !== 'simple_identifier'
        && child.type !== 'escaped_identifier'
    );
}

const nestedDesignUnitTypes = new Set([
    'module_declaration',
    'interface_declaration',
    'package_declaration',
    'program_declaration',
    'class_declaration',
]);

function moduleInstanceStatements(items: HdlSyntaxNode[]): HdlSyntaxNode[] {
    const statements: HdlSyntaxNode[] = [];
    const seen = new Set<string>();
    const visit = (node: HdlSyntaxNode): void => {
        if (node.type === 'module_instantiation' || node.type === 'udp_instantiation') {
            const key = `${node.startIndex}:${node.endIndex}`;
            if (!seen.has(key)) {
                seen.add(key);
                statements.push(node);
            }
            return;
        }
        if (opaqueTypes.has(node.type) || nestedDesignUnitTypes.has(node.type)) {
            return;
        }
        if (node.type !== 'module_item' && !node.type.includes('generate')) {
            return;
        }
        for (const child of node.namedChildren) {
            visit(child);
        }
    };
    for (const item of items) {
        visit(item);
    }
    return statements.sort((left, right) =>
        left.startIndex - right.startIndex || left.endIndex - right.endIndex
    );
}

function adaptModule(
    node: HdlSyntaxNode,
    declaredPrimitiveNames: ReadonlySet<string>,
    context: AdaptContext,
    diagnostics: HdlDiagnostic[]
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
    const endmoduleRange = endmoduleNode ?? offsetSpan(node.endIndex, node.endIndex);
    const labelSeparatorIndex = endmoduleIndex >= 0
        ? children.findIndex((child, index) => index > endmoduleIndex && child.type === ':')
        : -1;
    const endLabelNode = labelSeparatorIndex >= 0
        ? children.slice(labelSeparatorIndex + 1).find(child => identifierTypes.has(child.type))
        : undefined;
    const items = scopeItems(node, header);
    const parameterResult = adaptParameters(header, items, context);
    const portResult = header.type === 'module_ansi_header'
        ? adaptAnsiPorts(header, context, diagnostics)
        : adaptNonAnsiPorts(header, items, context);
    const instances: InstanceModel[] = [];
    const instanceDeclarationGroups: InstanceDeclarationGroupModel[] = [];
    const connectionReferenceNodes: HdlSyntaxNode[] = [];
    const nets: NetDeclarationModel[] = [];
    const variableDeclarationIds = new Set<string>();
    const continuousAssignments: ContinuousAssignModel[] = [];
    const pendingReferences: PendingReference[] = [];

    for (const structural of moduleInstanceStatements(items)) {
        if (declaredPrimitiveNames.has(
            structural.childForFieldName('instance_type')?.text ?? ''
        )) {
            continue;
        }
        const adapted = adaptInstance(structural, context);
        instances.push(...adapted.instances);
        if (adapted.group) {
            instanceDeclarationGroups.push(adapted.group);
        }
        connectionReferenceNodes.push(...adapted.referenceNodes);
    }

    for (const item of items) {
        const structural = item.type === 'module_item' && item.namedChildren.length === 1
            ? item.namedChildren[0]
            : item;
        if (structural.type === 'net_declaration' || structural.type === 'data_declaration') {
            const net = adaptNetDeclaration(structural, context);
            if (net) {
                nets.push(net);
                if (structural.type === 'data_declaration') {
                    variableDeclarationIds.add(net.id);
                }
            }
        } else if (structural.type === 'continuous_assign') {
            const adapted = adaptContinuousAssign(structural, context);
            continuousAssignments.push(...adapted.assignments);
            for (const reference of adapted.references) {
                for (const candidate of referenceNodes(reference.node)) {
                    pendingReferences.push({
                        name: candidate.node.text,
                        span: sourceSpan(candidate.node, context),
                        context: reference.context,
                        bindingEligible: candidate.bindingEligible,
                    });
                }
            }
        }
    }
    for (const expressionNode of connectionReferenceNodes) {
        for (const candidate of referenceNodes(expressionNode)) {
            pendingReferences.push({
                name: candidate.node.text,
                span: sourceSpan(candidate.node, context),
                context: 'connection',
                bindingEligible: candidate.bindingEligible,
            });
        }
    }

    const module: ModuleModel = {
        id: stableId('module', nameNode.text, nameNode.startIndex, context.request.uri),
        name: nameNode.text,
        nameSpan: sourceSpan(nameNode, context),
        declarationLine: declarationLine(node, context),
        endLabel: endLabelNode?.text,
        declarationStyle: header.type === 'module_ansi_header' ? 'ansi' : 'non-ansi',
        declarationSpan: sourceSpan(node, context),
        headerSpan: sourceSpan(header, context),
        bodySpan: sourceSpan(offsetSpan(bodyStart, bodyEnd), context),
        declarationRegionSpan: sourceSpan(offsetSpan(bodyStart, bodyEnd), context),
        endmoduleSpan: sourceSpan(endmoduleRange, context),
        parameters: parameterResult.parameters,
        localParameters: parameterResult.localParameters,
        ports: portResult.ports,
        portDeclarationGroups: portResult.groups,
        instances,
        instanceDeclarationGroups,
        nets,
        continuousAssignments,
        symbols: [],
        references: [],
        opaqueRegions: [],
    };
    module.symbols = buildSymbols(module, variableDeclarationIds, context);
    const opaque = adaptOpaqueRegions(items, module.symbols, context);
    module.opaqueRegions = opaque.regions;
    module.references = bindReferences(
        [...pendingReferences, ...opaque.references].sort((left, right) =>
            left.span.start - right.span.start
        ),
        module.symbols
    );
    return module;
}

function adaptNamedUnit(
    node: HdlSyntaxNode,
    kind: NamedUnitModel['kind'],
    context: AdaptContext
): NamedUnitModel | undefined {
    const header = node.namedChildren.find(child =>
        child.type === 'interface_ansi_header' || child.type === 'interface_nonansi_header'
    );
    const nameNode = node.childForFieldName('name') ?? header?.childForFieldName('name');
    if (!nameNode || nameNode.isMissing || nameNode.text.length === 0) {
        return undefined;
    }
    return {
        id: stableId(kind, nameNode.text, nameNode.startIndex, context.request.uri),
        kind,
        name: nameNode.text,
        nameSpan: sourceSpan(nameNode, context),
        declarationLine: declarationLine(node, context),
        declarationSpan: sourceSpan(node, context),
    };
}

function isDirective(node: HdlSyntaxNode): boolean {
    return node.type.endsWith('_directive') || node.type.endsWith('_compiler_directive');
}

function adaptDirective(node: HdlSyntaxNode, context: AdaptContext): DirectiveModel {
    return {
        kind: node.type,
        text: node.text,
        span: sourceSpan(node, context),
        active: true,
    };
}

function adaptInclude(node: HdlSyntaxNode, context: AdaptContext): IncludeModel {
    const pathNode = node.namedChildren.find(child =>
        child.type === 'quoted_string'
        || child.type === 'system_lib_string'
        || child.type === 'text_macro_usage'
    );
    let path = pathNode?.text ?? '';
    if ((path.startsWith('"') && path.endsWith('"'))
        || (path.startsWith('<') && path.endsWith('>'))) {
        path = path.slice(1, -1);
    }
    return { path, span: sourceSpan(node, context) };
}

function collectTopLevelUnits(root: HdlSyntaxNode): HdlSyntaxNode[] {
    const result: HdlSyntaxNode[] = [];
    const pending = [...root.namedChildren].reverse();
    while (pending.length > 0) {
        const node = pending.pop()!;
        if (node.type === 'module_declaration'
            || node.type === 'interface_declaration'
            || node.type === 'package_declaration') {
            result.push(node);
            continue;
        }
        const children = node.namedChildren;
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push(children[index]);
        }
    }
    return result.sort((left, right) => left.startIndex - right.startIndex);
}

function collectDeclaredPrimitiveNames(root: HdlSyntaxNode): Set<string> {
    const names = new Set<string>();
    for (const declaration of descendants(root, candidate => candidate.type === 'udp_declaration')) {
        const header = directChild(
            declaration,
            'udp_ansi_declaration',
            'udp_nonansi_declaration'
        );
        const name = header
            ? identifierChildren(header)[0]
            : identifierChildren(declaration)[0];
        if (name) {
            names.add(name.text);
        }
    }
    return names;
}

export function adaptTree(
    tree: HdlSyntaxTree,
    request: HdlSourceInput,
    sourceContext?: AdapterSourceContext
): HdlDocument {
    const transformedText = sourceContext?.text ?? request.text;
    const sourceMap = sourceContext?.sourceMap ?? new CompositeSourceMap([{
        generatedStart: 0,
        generatedEnd: transformedText.length,
        sourceUri: request.uri,
        sourceStart: 0,
        sourceEnd: transformedText.length,
    }]);
    const context: AdaptContext = {
        map: new PositionMap(transformedText),
        request,
        sourceMap,
        sourceTexts: sourceContext?.sourceTexts ?? { [request.uri]: request.text },
        transformedText,
        lineStartsByUri: new Map(),
    };
    const modules: ModuleModel[] = [];
    const interfaces: NamedUnitModel[] = [];
    const packages: NamedUnitModel[] = [];
    const directives: DirectiveModel[] = [];
    const includes: IncludeModel[] = [];
    const diagnostics: HdlDiagnostic[] = [];
    const declaredPrimitiveNames = collectDeclaredPrimitiveNames(tree.rootNode);

    for (const unit of collectTopLevelUnits(tree.rootNode)) {
        if (unit.type === 'module_declaration') {
            const module = adaptModule(unit, declaredPrimitiveNames, context, diagnostics);
            if (module) {
                modules.push(module);
            }
        } else {
            const kind = unit.type === 'interface_declaration' ? 'interface' : 'package';
            const adapted = adaptNamedUnit(unit, kind, context);
            if (adapted) {
                (kind === 'interface' ? interfaces : packages).push(adapted);
            }
        }
    }

    const pending = [tree.rootNode];
    while (pending.length > 0) {
        const node = pending.pop()!;
        if (node.isMissing) {
            diagnostics.push({
                severity: 'error',
                code: 'systemverilog.missing-syntax',
                message: `Missing SystemVerilog syntax: ${node.type}`,
                span: sourceSpan(node, context),
            });
        } else if (node.isError) {
            diagnostics.push({
                severity: 'error',
                code: 'systemverilog.syntax-error',
                message: 'SystemVerilog syntax error',
                span: sourceSpan(node, context),
            });
        }
        if (isDirective(node)) {
            directives.push(adaptDirective(node, context));
            if (node.type === 'include_compiler_directive') {
                includes.push(adaptInclude(node, context));
            }
        }
        const children = node.children;
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push(children[index]);
        }
    }
    directives.sort((left, right) => left.span.start - right.span.start);
    includes.sort((left, right) => left.span.start - right.span.start);
    diagnostics.sort((left, right) =>
        (left.span?.start ?? Number.MAX_SAFE_INTEGER)
        - (right.span?.start ?? Number.MAX_SAFE_INTEGER)
    );

    return {
        uri: request.uri,
        languageId: languageId(request.uri),
        version: request.version,
        textHash: createHash('sha256').update(request.text).digest('hex'),
        lineEnding: request.text.includes('\r\n') ? '\r\n' : '\n',
        preprocessingFingerprint: 'none',
        modules,
        interfaces,
        packages,
        directives,
        includes,
        diagnostics,
    };
}
