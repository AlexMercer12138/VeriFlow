export const ARCH_DESIGN_FORMAT = 'vik-veriflow.arch-design' as const;
export const ARCH_DESIGN_SCHEMA_VERSION = 1 as const;

export type ArchDesignWidth = number | Readonly<{ expression: string }>;
export type ArchDesignParameterValue = string | number | boolean;
export type ArchDesignPortDirection = 'input' | 'output' | 'inout';
export type ArchDesignLanguage = 'verilog' | 'systemverilog';
export type ArchDesignInoutSignal = 'value' | 'i' | 'o' | 't';

export type ArchDesignPort = Readonly<{
    name: string;
    direction: ArchDesignPortDirection;
    width?: ArchDesignWidth;
}>;

export type ArchDesignInstance = Readonly<{
    name: string;
    module: string;
    parameters?: Readonly<Record<string, ArchDesignParameterValue>>;
}>;

export type ArchDesignEndpoint =
    | Readonly<{
        kind: 'port';
        port: string;
        signal?: ArchDesignInoutSignal;
    }>
    | Readonly<{
        kind: 'instance';
        instance: string;
        port: string;
    }>;

export type ArchDesignConnection = Readonly<{
    name: string;
    endpoints: readonly ArchDesignEndpoint[];
    defaults?: Readonly<Record<string, string>>;
}>;

export type ArchDesignInterfaceRole = 'master' | 'slave';

export type ArchDesignInterfacePortMember = Readonly<{
    member: string;
    width: ArchDesignWidth;
}>;

export type ArchDesignInterfacePort = Readonly<{
    name: string;
    protocol: string;
    role: ArchDesignInterfaceRole;
    memberPrefix: string;
    members: readonly ArchDesignInterfacePortMember[];
}>;

export type ArchDesignInterfaceOverride = Readonly<{
    protocol?: string;
    role?: ArchDesignInterfaceRole;
}>;

export type ArchDesignInterfaceEndpoint =
    | Readonly<{
        kind: 'instance';
        instance: string;
        interface: string;
    }>
    | Readonly<{
        kind: 'port';
        port: string;
    }>;

export type ArchDesignInterfaceConnection = Readonly<{
    name: string;
    master: ArchDesignInterfaceEndpoint;
    slave: ArchDesignInterfaceEndpoint;
    defaults?: Readonly<Record<string, string>>;
}>;

export type ArchDesignExportOptions = Readonly<{
    language?: ArchDesignLanguage;
    output?: string;
}>;

export type ArchDesignNodePlacement = Readonly<{
    column: number;
    order: number;
    offset?: number;
    userPositioned?: boolean;
}>;

export type ArchDesignPresentation = Readonly<{
    nodes?: Readonly<Record<string, ArchDesignNodePlacement>>;
    collapsedInterfaces?: Readonly<Record<string, boolean>>;
}>;

export type ArchDesign = Readonly<{
    format: typeof ARCH_DESIGN_FORMAT;
    schemaVersion: typeof ARCH_DESIGN_SCHEMA_VERSION;
    module: string;
    ports: readonly ArchDesignPort[];
    instances: readonly ArchDesignInstance[];
    connections: readonly ArchDesignConnection[];
    interfacePorts: readonly ArchDesignInterfacePort[];
    interfaceOverrides: Readonly<Record<string, ArchDesignInterfaceOverride>>;
    interfaceConnections: readonly ArchDesignInterfaceConnection[];
    defaults: Readonly<Record<string, string>>;
    export: ArchDesignExportOptions;
    presentation: ArchDesignPresentation;
}>;

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const key of Reflect.ownKeys(value)) {
        deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    return Object.freeze(value);
}

export function createEmptyArchDesign(module: string): ArchDesign {
    if (typeof module !== 'string' || !PLAIN_IDENTIFIER.test(module)) {
        throw new TypeError('Arch Design module must be a valid Verilog identifier');
    }
    return deepFreeze({
        format: ARCH_DESIGN_FORMAT,
        schemaVersion: ARCH_DESIGN_SCHEMA_VERSION,
        module,
        ports: [],
        instances: [],
        connections: [],
        interfacePorts: [],
        interfaceOverrides: {},
        interfaceConnections: [],
        defaults: {},
        export: {},
        presentation: {},
    });
}
