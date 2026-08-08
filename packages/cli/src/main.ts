#!/usr/bin/env node

import os from 'node:os';

import { libAdd, libList, libRemove } from './commands/lib';
import {
    CommandEnvironment,
    CommandOptions,
    projectNew,
    projectOpen,
    projectShow,
} from './commands/project';
import { topGet, topSet } from './commands/top';

export interface CliEnvironment extends CommandEnvironment {}

type CommandHandler = (
    options: CommandOptions,
    environment: CliEnvironment
) => number | Promise<number>;

interface OptionDefinition {
    key: string;
    aliases: string[];
    requiredName?: string;
}

interface LeafCommand {
    help: string;
    options: OptionDefinition[];
    handler: CommandHandler;
}

const VERSION = '1.3.2';

const ROOT_HELP = `usage: veriflow [-h] [-v] COMMAND ...

VeriFlow - Lightweight Verilog Simulation Manager

positional arguments:
  COMMAND
    project      project management
    lib          global library management
    top          top module management
    analyze      analyze dependencies
    sim          compile and simulate
    wave         open waveform viewer

options:
  -h, --help     show this help message and exit
  -v, --version  show program's version number and exit
`;

const PROJECT_HELP = `usage: veriflow project [-h] ACTION ...

positional arguments:
  ACTION
    new       create new project (auto-saved)
    open      open and show project
    show      show project details

options:
  -h, --help  show this help message and exit
`;

const LIB_HELP = `usage: veriflow lib [-h] ACTION ...

positional arguments:
  ACTION
    add       add global library
    remove    remove global library
    list      list global libraries

options:
  -h, --help  show this help message and exit
`;

const TOP_HELP = `usage: veriflow top [-h] ACTION ...

positional arguments:
  ACTION
    set       set top module (auto-saved)
    get       get current top module

options:
  -h, --help  show this help message and exit
`;

const PROJECT_NEW_HELP = `usage: veriflow project new [-h] -n NAME [-r ROOT] [-t TOP] [-L LIB] [-s SIM]
                            [-w WAVE] [--output OUTPUT]

options:
  -h, --help           show this help message and exit
  -n, --name NAME      project name
  -r, --root ROOT      project root directory
  -t, --top TOP        top module name
  -L, --lib LIB        lib dirs (comma separated)
  -s, --sim SIM        simulator (iverilog/vcs/xsim/custom)
  -w, --wave WAVE      wave viewer (builtin/surfer/gtkwave/custom)
  --output, -o OUTPUT  output JSON file path
`;

const PROJECT_OPEN_HELP = `usage: veriflow project open [-h] --project PROJECT

options:
  -h, --help            show this help message and exit
  --project, -p PROJECT
                        project JSON file
`;

const PROJECT_SHOW_HELP = PROJECT_OPEN_HELP.replace('project open', 'project show');

const LIB_ADD_HELP = `usage: veriflow lib add [-h] -L LIB

options:
  -h, --help     show this help message and exit
  -L, --lib LIB  library directory
`;

const LIB_REMOVE_HELP = LIB_ADD_HELP.replace('lib add', 'lib remove');

const LIB_LIST_HELP = `usage: veriflow lib list [-h]

options:
  -h, --help  show this help message and exit
`;

const TOP_SET_HELP = `usage: veriflow top set [-h] -p PROJECT -t TOP

options:
  -h, --help            show this help message and exit
  -p, --project PROJECT
                        project JSON file
  -t, --top TOP         top module name
`;

const TOP_GET_HELP = `usage: veriflow top get [-h] -p PROJECT

options:
  -h, --help            show this help message and exit
  -p, --project PROJECT
                        project JSON file
`;

const LEAF_COMMANDS: Record<string, LeafCommand> = {
    'project new': {
        help: PROJECT_NEW_HELP,
        options: [
            { key: 'name', aliases: ['-n', '--name'], requiredName: '-n/--name' },
            { key: 'root', aliases: ['-r', '--root'] },
            { key: 'top', aliases: ['-t', '--top'] },
            { key: 'lib', aliases: ['-L', '--lib'] },
            { key: 'sim', aliases: ['-s', '--sim'] },
            { key: 'wave', aliases: ['-w', '--wave'] },
            { key: 'output', aliases: ['--output', '-o'] },
        ],
        handler: projectNew,
    },
    'project open': {
        help: PROJECT_OPEN_HELP,
        options: [
            { key: 'project', aliases: ['--project', '-p'], requiredName: '--project/-p' },
        ],
        handler: projectOpen,
    },
    'project show': {
        help: PROJECT_SHOW_HELP,
        options: [
            { key: 'project', aliases: ['--project', '-p'], requiredName: '--project/-p' },
        ],
        handler: projectShow,
    },
    'lib add': {
        help: LIB_ADD_HELP,
        options: [
            { key: 'lib', aliases: ['-L', '--lib'], requiredName: '-L/--lib' },
        ],
        handler: libAdd,
    },
    'lib remove': {
        help: LIB_REMOVE_HELP,
        options: [
            { key: 'lib', aliases: ['-L', '--lib'], requiredName: '-L/--lib' },
        ],
        handler: libRemove,
    },
    'lib list': {
        help: LIB_LIST_HELP,
        options: [],
        handler: libList,
    },
    'top set': {
        help: TOP_SET_HELP,
        options: [
            { key: 'project', aliases: ['-p', '--project'], requiredName: '-p/--project' },
            { key: 'top', aliases: ['-t', '--top'], requiredName: '-t/--top' },
        ],
        handler: topSet,
    },
    'top get': {
        help: TOP_GET_HELP,
        options: [
            { key: 'project', aliases: ['-p', '--project'], requiredName: '-p/--project' },
        ],
        handler: topGet,
    },
};

const PARENT_HELP: Record<string, string> = {
    project: PROJECT_HELP,
    lib: LIB_HELP,
    top: TOP_HELP,
};

const PARENT_ACTIONS: Record<string, string[]> = {
    project: ['new', 'open', 'show'],
    lib: ['add', 'remove', 'list'],
    top: ['set', 'get'],
};

function usage(help: string): string {
    return `${help.split('\n\n', 1)[0]}\n`;
}

function parseError(
    environment: CliEnvironment,
    command: string,
    help: string,
    message: string
): number {
    environment.stderr(`${usage(help)}veriflow ${command}: error: ${message}\n`);
    return 2;
}

function parseOptions(
    command: string,
    argv: string[],
    definition: LeafCommand,
    environment: CliEnvironment
): CommandOptions | number {
    if (argv.includes('-h') || argv.includes('--help')) {
        environment.stdout(definition.help);
        return 0;
    }

    const byAlias = new Map<string, OptionDefinition>();
    for (const option of definition.options) {
        for (const alias of option.aliases) byAlias.set(alias, option);
    }

    const values: CommandOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const option = byAlias.get(argument);
        if (!option) {
            return parseError(
                environment,
                command,
                definition.help,
                `unrecognized arguments: ${argument}`
            );
        }
        const value = argv[index + 1];
        if (value === undefined || byAlias.has(value)) {
            return parseError(
                environment,
                command,
                definition.help,
                `argument ${option.aliases.join('/')}: expected one argument`
            );
        }
        values[option.key] = value;
        index += 1;
    }

    const missing = definition.options
        .filter(option => option.requiredName && values[option.key] === undefined)
        .map(option => option.requiredName!);
    if (missing.length > 0) {
        return parseError(
            environment,
            command,
            definition.help,
            `the following arguments are required: ${missing.join(', ')}`
        );
    }
    return values;
}

export async function runCli(argv: string[], environment: CliEnvironment): Promise<number> {
    if (argv.length === 0) {
        environment.stdout(ROOT_HELP);
        return 0;
    }
    if (argv[0] === '-h' || argv[0] === '--help') {
        environment.stdout(ROOT_HELP);
        return 0;
    }
    if (argv[0] === '-v' || argv[0] === '--version') {
        environment.stdout(`VeriFlow ${VERSION}\n`);
        return 0;
    }

    const parent = argv[0];
    if (!(parent in PARENT_HELP)) {
        environment.stderr(
            `${usage(ROOT_HELP)}veriflow: error: argument COMMAND: invalid choice: '${parent}' `
            + `(choose from project, lib, top, analyze, sim, wave)\n`
        );
        return 2;
    }
    if (argv.length === 1) {
        environment.stdout(ROOT_HELP);
        return 0;
    }
    if (argv[1] === '-h' || argv[1] === '--help') {
        environment.stdout(PARENT_HELP[parent]);
        return 0;
    }

    const action = argv[1];
    const commandName = `${parent} ${action}`;
    const definition = LEAF_COMMANDS[commandName];
    if (!definition) {
        const choices = PARENT_ACTIONS[parent].join(', ');
        environment.stderr(
            `${usage(PARENT_HELP[parent])}veriflow ${parent}: error: argument ACTION: `
            + `invalid choice: '${action}' (choose from ${choices})\n`
        );
        return 2;
    }

    const parsed = parseOptions(commandName, argv.slice(2), definition, environment);
    if (typeof parsed === 'number') return parsed;

    try {
        return await definition.handler(parsed, environment);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        environment.stderr(`Error: ${message}\n`);
        return 1;
    }
}

if (require.main === module) {
    void runCli(process.argv.slice(2), {
        cwd: process.cwd(),
        homeDir: os.homedir(),
        stdout: text => { process.stdout.write(text); },
        stderr: text => { process.stderr.write(text); },
    }).then(exitCode => {
        process.exitCode = exitCode;
    });
}
