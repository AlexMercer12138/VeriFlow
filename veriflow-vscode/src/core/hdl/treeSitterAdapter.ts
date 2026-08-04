import { createHash } from 'crypto';
import type { Node, Tree } from 'web-tree-sitter';

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
import type { ParseRequest } from './protocol';

type ByteRange = {
    startIndex: number;
    endIndex: number;
};

type AdaptContext = {
    map: PositionMap;
    request: ParseRequest;
};

type PendingReference = Omit<SymbolReferenceModel, 'symbolId'>;

const identifierTypes = new Set(['simple_identifier', 'escaped_identifier']);
const opaqueTypes = new Set([
    'always_construct',
    'initial_construct',
    'final_construct',
    'task_declaration',
    'function_declaration',
]);

function sourceSpan(range: ByteRange, context: AdaptContext): SourceSpan {
    // web-tree-sitter's JavaScript input callback exposes UTF-16 indexes. Normalize
    // them to UTF-8 bytes so PositionMap remains the single byte-to-source boundary.
    const byteStart = context.map.utf16ToByte(range.startIndex);
    const byteEnd = context.map.utf16ToByte(range.endIndex);
    return {
        ...context.map.byteRangeToSourceRange(byteStart, byteEnd),
        uri: context.request.uri,
    };
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

function descendants(node: Node, predicate: (candidate: Node) => boolean): Node[] {
    const result: Node[] = [];
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

function firstDescendant(node: Node, types: ReadonlySet<string>): Node | undefined {
    if (types.has(node.type)) {
        return node;
    }
    return descendants(node, candidate => types.has(candidate.type))[0];
}

function directChild(node: Node, ...types: string[]): Node | undefined {
    return node.namedChildren.find(child => types.includes(child.type));
}

function identifierChildren(node: Node): Node[] {
    return node.namedChildren.filter(child => identifierTypes.has(child.type));
}

function separatorSpan(current: Node, next: Node | undefined, context: AdaptContext): SourceSpan | undefined {
    return next
        ? sourceSpan(offsetSpan(current.endIndex, next.startIndex), context)
        : undefined;
}

function packedRange(node: Node): Node | undefined {
    return firstDescendant(node, new Set(['packed_dimension']));
}

function typeNode(node: Node): Node | undefined {
    return firstDescendant(
        node,
        new Set(['data_type', 'implicit_data_type', 'net_type', 'interface_port_header'])
    );
}

function textWithoutRange(node: Node | undefined, range: Node | undefined, request: ParseRequest): string {
    if (!node) {
        return '';
    }
    if (!range || range.startIndex < node.startIndex || range.endIndex > node.endIndex) {
        return node.text.trim();
    }
    return (
        request.text.slice(node.startIndex, range.startIndex)
        + request.text.slice(range.endIndex, node.endIndex)
    ).trim();
}

function simpleInteger(text: string): number | undefined {
    const normalized = text.split('_').join('').trim();
    return /^[0-9]+$/.test(normalized) ? Number(normalized) : undefined;
}

function widthFromRange(range: Node | undefined): WidthValue {
    if (!range) {
        return { kind: 'known', bits: 1 };
    }
    const constantRange = firstDescendant(range, new Set(['constant_range']));
    const bounds = constantRange?.namedChildren.filter(child => child.type === 'constant_expression') ?? [];
    if (bounds.length === 2) {
        const left = simpleInteger(bounds[0].text);
        const right = simpleInteger(bounds[1].text);
        if (left !== undefined && right !== undefined) {
            return { kind: 'known', bits: Math.abs(left - right) + 1 };
        }
    }
    return { kind: 'symbolic', expression: range.text };
}

function hasDescendant(node: Node, predicate: (candidate: Node) => boolean): boolean {
    return predicate(node) || descendants(node, predicate).length > 0;
}

function expressionWidth(node: Node, kind: ExpressionModel['kind']): WidthValue {
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

function adaptExpression(node: Node, context: AdaptContext): ExpressionModel {
    const hasSelect = hasDescendant(node, candidate =>
        candidate.type.includes('select') || candidate.type.includes('part_select')
    );
    const hasConcat = hasDescendant(node, candidate => candidate.type.includes('concatenation'));
    const hasOperator = hasDescendant(node, candidate => candidate.type.endsWith('_operator'));
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
    if (hasConcat) {
        kind = 'concat';
    } else if (hasSelect) {
        kind = 'select';
    } else if (hasOperator) {
        kind = 'operation';
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

function referenceNodes(node: Node): Node[] {
    const nodes = descendants(node, candidate => identifierTypes.has(candidate.type));
    if (identifierTypes.has(node.type)) {
        nodes.unshift(node);
    }
    return nodes;
}

function adaptParameterDeclaration(
    declaration: Node,
    kind: ParameterModel['kind'],
    context: AdaptContext
): ParameterModel[] {
    const list = declaration.type === 'list_of_param_assignments'
        ? declaration
        : directChild(declaration, 'list_of_param_assignments');
    if (!list) {
        return [];
    }
    const range = packedRange(declaration);
    const declarationType = textWithoutRange(typeNode(declaration), range, context.request);
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
    header: Node,
    scopeItems: Node[],
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

function directionFromNode(node: Node | undefined): PortModel['direction'] | undefined {
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
    header: Node,
    context: AdaptContext
): { ports: PortModel[]; groups: PortDeclarationGroupModel[] } {
    const list = directChild(header, 'list_of_port_declarations');
    if (!list) {
        return { ports: [], groups: [] };
    }
    const declarations = list.namedChildren.filter(child => child.type === 'ansi_port_declaration');
    const ports: PortModel[] = [];
    const groups: PortDeclarationGroupModel[] = [];
    let inherited: PortPrefix | undefined;
    let currentGroup: PortDeclarationGroupModel | undefined;

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
        const rangeNode = explicitHeader ? packedRange(explicitHeader) : undefined;
        const explicitDirection = directionFromNode(explicitHeader);
        const prefix: PortPrefix = explicitHeader
            ? {
                direction: explicitDirection ?? inherited?.direction ?? 'input',
                typeText: textWithoutRange(typeNode(explicitHeader), rangeNode, context.request),
                packedRange: rangeNode?.text,
                width: widthFromRange(rangeNode),
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
            offsetSpan(currentGroup.declarationSpan.start, declaration.endIndex),
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
            packedRangeSpan: rangeNode ? sourceSpan(rangeNode, context) : undefined,
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

function unwrapPortDeclaration(item: Node): { wrapper: Node; declaration: Node } | undefined {
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
    header: Node,
    scopeItems: Node[],
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
        const rangeNode = packedRange(declaration);
        const listNode = directChild(
            declaration,
            'list_of_port_identifiers',
            'list_of_variable_identifiers'
        );
        const names = listNode ? identifierChildren(listNode) : [];
        if (names.length === 0) {
            continue;
        }
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

        const declarationType = textWithoutRange(typeNode(declaration), rangeNode, context.request);
        names.forEach((nameNode, index) => {
            const port = portByName.get(nameNode.text);
            if (!port) {
                return;
            }
            port.direction = direction;
            port.typeText = declarationType;
            port.packedRange = rangeNode?.text;
            port.width = widthFromRange(rangeNode);
            port.declarationSpan = sourceSpan(wrapper, context);
            const directionNode = declaration.children.find(child => child.type === direction);
            port.directionSpan = index === 0 && directionNode
                ? sourceSpan(directionNode, context)
                : undefined;
            port.nameSpan = sourceSpan(nameNode, context);
            port.bodyDeclarationSpan = sourceSpan(wrapper, context);
            port.bodyNameSpan = sourceSpan(nameNode, context);
            port.packedRangeSpan = index === 0 && rangeNode
                ? sourceSpan(rangeNode, context)
                : undefined;
            port.declarationGroupId = groupId;
            port.inheritsDirection = index > 0;
            port.inheritsType = index > 0;
            port.inheritsPackedRange = index > 0 && rangeNode !== undefined;
        });
    }
    return { ports, groups };
}

function emptyExpressionSpan(connection: Node, context: AdaptContext): SourceSpan {
    const leftParen = connection.children.find(child => child.type === '(');
    const insertion = leftParen?.endIndex ?? connection.endIndex;
    return sourceSpan(offsetSpan(insertion, insertion), context);
}

function adaptNamedConnection(
    connection: Node,
    context: AdaptContext
): { model: InstanceConnectionModel; expressionNode?: Node } {
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
    list: Node | undefined,
    context: AdaptContext
): { models: InstanceConnectionModel[]; expressionNodes: Node[] } {
    if (!list) {
        return { models: [], expressionNodes: [] };
    }
    const models: InstanceConnectionModel[] = [];
    const expressionNodes: Node[] = [];
    for (const connection of list.namedChildren) {
        if (connection.type === 'named_port_connection'
            || connection.type === 'named_parameter_assignment') {
            const adapted = adaptNamedConnection(connection, context);
            models.push(adapted.model);
            if (adapted.expressionNode) {
                expressionNodes.push(adapted.expressionNode);
            }
        } else if (connection.type === 'ordered_port_connection'
            || connection.type === 'ordered_parameter_assignment') {
            const expressionNode = connection.namedChildren[0];
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
    statement: Node,
    context: AdaptContext
): {
    instances: InstanceModel[];
    group?: InstanceDeclarationGroupModel;
    referenceNodes: Node[];
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
    item: Node,
    context: AdaptContext
): { models: InstanceConnectionModel[]; expressionNodes: Node[] } {
    const models: InstanceConnectionModel[] = [];
    const expressionNodes: Node[] = [];
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

function adaptNetDeclaration(node: Node, context: AdaptContext): NetDeclarationModel | undefined {
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
    const rangeNode = packedRange(node);
    const vectorType = firstDescendant(node, new Set(['integer_vector_type']))?.text;
    const netType = directChild(node, 'net_type')?.text;
    const kind: NetDeclarationModel['kind'] = isNet
        ? netType === 'wire' || netType === undefined ? 'wire' : 'other'
        : vectorType === 'logic' ? 'logic' : vectorType === 'reg' ? 'reg' : 'other';
    const baseType = textWithoutRange(typeNode(node), rangeNode, context.request);
    return {
        id: stableId('declaration', names[0].name, node.startIndex, context.request.uri),
        kind,
        typeText: [netType, baseType].filter(Boolean).join(' '),
        names,
        declarationSpan: sourceSpan(node, context),
        packedRange: rangeNode?.text,
        width: widthFromRange(rangeNode),
    };
}

function adaptContinuousAssign(
    node: Node,
    context: AdaptContext
): { assignments: ContinuousAssignModel[]; references: Array<{ node: Node; context: PendingReference['context'] }> } {
    const list = directChild(node, 'list_of_net_assignments', 'list_of_variable_assignments');
    const assignments: ContinuousAssignModel[] = [];
    const references: Array<{ node: Node; context: PendingReference['context'] }> = [];
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
    });
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
    return pending.map(reference => ({
        ...reference,
        symbolId: byName.get(reference.name)?.id,
    }));
}

function adaptOpaqueRegions(
    items: Node[],
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
        const shadowed = new Set<string>();
        for (const declaration of descendants(opaque, candidate => candidate.type === 'data_declaration')) {
            const list = directChild(declaration, 'list_of_variable_decl_assignments');
            for (const assignment of list?.namedChildren ?? []) {
                const name = assignment.childForFieldName('name');
                if (name) {
                    shadowed.add(name.text);
                }
            }
        }
        for (const port of descendants(opaque, candidate => candidate.type === 'tf_port_item')) {
            const name = port.childForFieldName('name');
            if (name) {
                shadowed.add(name.text);
            }
        }
        for (const portList of descendants(
            opaque,
            candidate => candidate.type === 'list_of_tf_variable_identifiers'
        )) {
            for (const name of identifierChildren(portList)) {
                shadowed.add(name.text);
            }
        }
        const body = firstDescendant(
            opaque,
            new Set(['function_body_declaration', 'task_body_declaration'])
        );
        const bodyName = body?.childForFieldName('name');
        if (bodyName) {
            shadowed.add(bodyName.text);
        }
        const boundaryNames: string[] = [];
        for (const identifier of descendants(opaque, candidate => identifierTypes.has(candidate.type))) {
            if (!symbolNames.has(identifier.text) || shadowed.has(identifier.text)) {
                continue;
            }
            if (!boundaryNames.includes(identifier.text)) {
                boundaryNames.push(identifier.text);
            }
            references.push({
                name: identifier.text,
                span: sourceSpan(identifier, context),
                context: 'unknown',
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

function scopeItems(module: Node, header: Node): Node[] {
    return module.namedChildren.filter(child =>
        child !== header
        && child.type !== 'simple_identifier'
        && child.type !== 'escaped_identifier'
    );
}

function adaptModule(node: Node, context: AdaptContext): ModuleModel | undefined {
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
        ? adaptAnsiPorts(header, context)
        : adaptNonAnsiPorts(header, items, context);
    const instances: InstanceModel[] = [];
    const instanceDeclarationGroups: InstanceDeclarationGroupModel[] = [];
    const connectionReferenceNodes: Node[] = [];
    const nets: NetDeclarationModel[] = [];
    const variableDeclarationIds = new Set<string>();
    const continuousAssignments: ContinuousAssignModel[] = [];
    const pendingReferences: PendingReference[] = [];

    for (const item of items) {
        const structural = item.type === 'module_item' && item.namedChildren.length === 1
            ? item.namedChildren[0]
            : item;
        if (structural.type === 'module_instantiation' || structural.type === 'udp_instantiation') {
            const adapted = adaptInstance(structural, context);
            instances.push(...adapted.instances);
            if (adapted.group) {
                instanceDeclarationGroups.push(adapted.group);
            }
            connectionReferenceNodes.push(...adapted.referenceNodes);
        } else if (structural.type === 'net_declaration' || structural.type === 'data_declaration') {
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
                for (const identifier of referenceNodes(reference.node)) {
                    pendingReferences.push({
                        name: identifier.text,
                        span: sourceSpan(identifier, context),
                        context: reference.context,
                    });
                }
            }
        }
    }
    for (const expressionNode of connectionReferenceNodes) {
        for (const identifier of referenceNodes(expressionNode)) {
            pendingReferences.push({
                name: identifier.text,
                span: sourceSpan(identifier, context),
                context: 'connection',
            });
        }
    }

    const module: ModuleModel = {
        id: stableId('module', nameNode.text, nameNode.startIndex, context.request.uri),
        name: nameNode.text,
        nameSpan: sourceSpan(nameNode, context),
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
    node: Node,
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
        declarationSpan: sourceSpan(node, context),
    };
}

function isDirective(node: Node): boolean {
    return node.type.endsWith('_directive') || node.type.endsWith('_compiler_directive');
}

function adaptDirective(node: Node, context: AdaptContext): DirectiveModel {
    return {
        kind: node.type,
        text: node.text,
        span: sourceSpan(node, context),
        active: true,
    };
}

function adaptInclude(node: Node, context: AdaptContext): IncludeModel {
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

function collectTopLevelUnits(root: Node): Node[] {
    const result: Node[] = [];
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

export function adaptTree(tree: Tree, request: ParseRequest): HdlDocument {
    const context: AdaptContext = { map: new PositionMap(request.text), request };
    const modules: ModuleModel[] = [];
    const interfaces: NamedUnitModel[] = [];
    const packages: NamedUnitModel[] = [];
    const directives: DirectiveModel[] = [];
    const includes: IncludeModel[] = [];
    const diagnostics: HdlDiagnostic[] = [];

    for (const unit of collectTopLevelUnits(tree.rootNode)) {
        if (unit.type === 'module_declaration') {
            const module = adaptModule(unit, context);
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
