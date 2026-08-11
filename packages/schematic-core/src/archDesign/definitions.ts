import type { WidthValue } from '@veriflow/hdl-core/model';

export type ArchDesignDefinitionParameter = Readonly<{
    name: string;
    defaultExpression?: string;
}>;

export type ArchDesignDefinitionPort = Readonly<{
    name: string;
    direction: 'input' | 'output' | 'inout';
    width: WidthValue;
}>;

export type ArchDesignModuleDefinition = Readonly<{
    key: string;
    name: string;
    parameters: readonly ArchDesignDefinitionParameter[];
    ports: readonly ArchDesignDefinitionPort[];
}>;
