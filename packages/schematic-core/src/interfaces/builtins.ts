import ahbLiteValue from './builtins/ahb-lite.json';
import apbValue from './builtins/apb.json';
import axi4Value from './builtins/axi4.json';
import axisValue from './builtins/axis.json';

export const BUILTIN_INTERFACE_PROTOCOL_IDS = Object.freeze([
    'amba.axi4',
    'amba.axis',
    'amba.apb',
    'amba.ahb-lite',
] as const);

export const BUILTIN_INTERFACE_PROTOCOL_VALUES = Object.freeze([
    Object.freeze({ source: 'builtin:axi4.json', value: axi4Value as unknown }),
    Object.freeze({ source: 'builtin:axis.json', value: axisValue as unknown }),
    Object.freeze({ source: 'builtin:apb.json', value: apbValue as unknown }),
    Object.freeze({ source: 'builtin:ahb-lite.json', value: ahbLiteValue as unknown }),
]);
