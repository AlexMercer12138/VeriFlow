import { SimulatorConfig, WaveViewerConfig } from './types';

export const DEFAULT_SIMULATORS: Readonly<Record<string, SimulatorConfig>> = {
    iverilog: {
        name: 'iverilog',
        compileCmd: 'iverilog -o "{output}" {files}',
        runCmd: 'vvp "{output}"',
    },
    'native-iverilog': {
        name: 'native-iverilog',
        compileCmd: 'iverilog -g2005 -o "{output}" {defines} {include_dirs} {files}',
        runCmd: 'vvp "{output}"',
    },
    vcs: {
        name: 'vcs',
        compileCmd: 'vcs -full64 -o "{output}" {files}',
        runCmd: './"{output}"',
    },
    xsim: {
        name: 'xsim',
        compileCmd: 'xvlog {files} && xelab {top_module} -snapshot "{output}"',
        runCmd: 'xsim "{output}" --runall',
    },
    custom: {
        name: 'custom',
        compileCmd: '',
        runCmd: '',
    },
};

export const DEFAULT_WAVE_VIEWERS: Readonly<Record<string, WaveViewerConfig>> = {
    builtin: { name: 'builtin', launchCmd: '' },
    surfer: { name: 'surfer', launchCmd: 'surfer "{wave_file}"' },
    gtkwave: { name: 'gtkwave', launchCmd: 'gtkwave "{wave_file}"' },
    custom: { name: 'custom', launchCmd: '' },
};

export const DEFAULT_GLOBAL_CONFIG = {
    version: '1.1.0',
    lib_dirs: [] as string[],
    language: 'zh',
    theme: 'dark',
};
