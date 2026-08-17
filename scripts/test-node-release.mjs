import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNpmInvocation } from './lib/npm-command.mjs';
import { readIverilogSource } from './lib/iverilog-source.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishable = [
    {
        name: '@veriflow/flow-core',
        workspace: 'packages/flow-core',
        requiredFiles: ['dist/index.js'],
    },
    {
        name: '@veriflow/hdl-core',
        workspace: 'packages/hdl-core',
        requiredFiles: ['dist/index.js'],
    },
    {
        name: '@veriflow/schematic-core',
        workspace: 'packages/schematic-core',
        requiredFiles: [
            'dist/index.js',
            'dist/model.js',
            'dist/archDesign/interfaces.js',
            'dist/interfaces/index.js',
            'dist/interfaces/catalog.js',
            'dist/interfaces/recognition.js',
            'dist/interfaces/builtins/axi4.json',
            'dist/interfaces/builtins/axis.json',
            'dist/interfaces/builtins/apb.json',
            'dist/interfaces/builtins/ahb-lite.json',
        ],
    },
    {
        name: '@veriflow/hdl-runtime',
        workspace: 'packages/hdl-runtime',
        requiredFiles: ['dist/index.js', 'dist/parserWorker.js'],
    },
    {
        name: '@veriflow/waveform-runtime',
        workspace: 'packages/waveform-runtime',
        requiredFiles: ['dist/index.js', 'dist/waveformWorker.js'],
    },
    {
        name: '@veriflow/waveform-desktop',
        workspace: 'packages/waveform-desktop',
        requiredFiles: [
            'assets/waveform/index.html',
            'assets/waveform/index.js',
            'dist/launcher.js',
            'dist/main.js',
            'dist/preload.js',
            'dist/router.js',
            'scripts/install-electron.cjs',
        ],
    },
    {
        name: '@veriflow/simulator-iverilog-wasm',
        workspace: 'packages/simulator-iverilog-wasm',
        requiredFiles: ['dist/index.js'],
    },
    {
        name: '@veriflow/cli',
        workspace: 'packages/cli',
        requiredFiles: [
            'dist/main.js',
            'dist/commands/ad.js',
            'dist/runtime/interfaceProtocolLoader.js',
        ],
    },
];

const packScript = readFileSync(path.join(repositoryRoot, 'scripts', 'pack-node-release.mjs'), 'utf8');
assert.match(
    packScript,
    /readIverilogSource\(/,
    'local Node packaging must validate installed Icarus source metadata'
);
const packedWorkspaces = [...packScript.matchAll(/^\s{4}'(@veriflow\/[^']+)',$/gm)]
    .map(match => match[1]);
assert.deepEqual(
    packedWorkspaces,
    publishable.map(entry => entry.name),
    'pack-node-release workspaces must match release smoke packages'
);

function run(command, args, cwd = repositoryRoot, env = process.env) {
    try {
        return execFileSync(command, args, {
            cwd,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stdout = error.stdout?.toString() ?? '';
        const stderr = error.stderr?.toString() ?? '';
        throw new Error(`${command} ${args.join(' ')} failed\n${stdout}${stderr}`);
    }
}

function readJson(filepath) {
    return JSON.parse(readFileSync(filepath, 'utf8'));
}

function runNpm(args, cwd = repositoryRoot, environment = process.env) {
    const invocation = resolveNpmInvocation(args, {
        npmExecutable: environment.npm_execpath,
    });
    return run(invocation.executable, invocation.args, cwd, environment);
}

function invokeCli(cliEntry, args, cwd, environment) {
    return spawnSync(process.execPath, [cliEntry, ...args], {
        cwd,
        env: environment,
        encoding: 'utf8',
        shell: false,
    });
}

const rootVersion = readJson(path.join(repositoryRoot, 'package.json')).version;
const publishedNames = new Set(publishable.map(entry => entry.name));
for (const entry of publishable) {
    const manifest = readJson(path.join(repositoryRoot, entry.workspace, 'package.json'));
    assert.notEqual(manifest.private, true, `${entry.name} must not be private`);
    assert.equal(manifest.version, rootVersion, `${entry.name} version`);
    assert.equal(manifest.publishConfig?.access, 'public', `${entry.name} public access`);
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (publishedNames.has(dependency)) {
            assert.equal(version, rootVersion, `${entry.name} dependency ${dependency}`);
        }
    }
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-node-release-'));
const packRoot = path.join(temporaryRoot, 'packs');
const installRoot = path.join(temporaryRoot, 'install');
mkdirSync(packRoot, { recursive: true });
mkdirSync(installRoot, { recursive: true });

try {
    runNpm(['run', 'build:cli']);
    const tarballs = [];
    for (const entry of publishable) {
        const before = new Set(readdirSync(packRoot));
        const output = runNpm([
            '--silent',
            'pack',
            '--workspace',
            entry.name,
            '--pack-destination',
            packRoot,
            '--json',
        ]);
        const packed = JSON.parse(output)[0];
        const files = new Set(packed.files.map(file => file.path));
        for (const required of entry.requiredFiles) {
            assert.equal(files.has(required), true, `${entry.name} missing ${required}`);
        }
        const forbiddenFiles = [...files].filter(file => (
            /(^|\/)(src|test|tests|dist-test)(\/|$)/i.test(file)
            || /(^|\/)(__pycache__|python)(\/|$)/i.test(file)
            || /\.(py|pyc|pyo|pyd|whl|tsx)$/i.test(file)
            || /(?<!\.d)\.ts$/i.test(file)
        ));
        assert.deepEqual(
            forbiddenFiles,
            [],
            `${entry.name} must not contain source, test, or Python artifacts`
        );
        const created = readdirSync(packRoot).filter(filename => !before.has(filename));
        assert.equal(created.length, 1, `${entry.name} tarball count`);
        tarballs.push(path.join(packRoot, created[0]));
    }

    writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({
        name: 'veriflow-release-smoke',
        version: '0.0.0',
        private: true,
    }, null, 2));
    const homeDir = path.join(temporaryRoot, 'home');
    mkdirSync(homeDir, { recursive: true });
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== 'npm_config_allow_scripts'
    ));
    const environment = {
        ...inheritedEnvironment,
        HOME: homeDir,
        USERPROFILE: homeDir,
        VERIFLOW_SKIP_ELECTRON_DOWNLOAD: '1',
    };
    runNpm([
        'install',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        ...tarballs,
    ], installRoot, environment);

    const installedPackage = realpathSync(path.join(
        installRoot,
        'node_modules',
        '@veriflow',
        'cli'
    ));
    assert.equal(installedPackage.startsWith(realpathSync(installRoot)), true);
    const installedAdapter = realpathSync(path.join(
        installRoot,
        'node_modules',
        '@veriflow',
        'simulator-iverilog-wasm'
    ));
    assert.equal(installedAdapter.startsWith(realpathSync(installRoot)), true);
    const installedAdapterManifest = readJson(path.join(installedAdapter, 'package.json'));
    assert.equal(installedAdapterManifest.version, rootVersion);
    const installedCliManifest = readJson(path.join(installedPackage, 'package.json'));
    assert.equal(
        installedCliManifest.dependencies?.['@veriflow/schematic-core'],
        rootVersion,
        'installed CLI must depend on the published schematic-core version'
    );
    assert.equal(
        installedCliManifest.dependencies?.['@veriflow/simulator-iverilog-wasm'],
        rootVersion,
        'installed CLI must depend on the published adapter version'
    );
    const upstreamVersion = installedAdapterManifest.dependencies?.['@veriflow/iverilog-wasm'];
    assert.equal(upstreamVersion, '0.1.2', 'supported upstream Icarus package version');
    const installedUpstream = realpathSync(path.join(
        installRoot,
        'node_modules',
        '@veriflow',
        'iverilog-wasm'
    ));
    const installedProvenance = readIverilogSource({
        packageRoot: installedUpstream,
        expectedName: '@veriflow/iverilog-wasm',
        expectedVersion: upstreamVersion,
    });
    for (const relative of ['LICENSE', 'dist/SOURCE.md']) {
        assert.notEqual(
            readFileSync(path.join(installedUpstream, relative), 'utf8').trim(),
            '',
            `installed upstream ${relative} must be non-empty`
        );
    }
    const installedInterfaces = await import(pathToFileURL(path.join(
        installRoot,
        'node_modules',
        '@veriflow',
        'schematic-core',
        'dist',
        'interfaces',
        'index.js'
    )).href);
    assert.deepEqual(installedInterfaces.BUILTIN_INTERFACE_PROTOCOL_IDS, [
        'amba.axi4',
        'amba.axis',
        'amba.apb',
        'amba.ahb-lite',
    ]);
    assert.deepEqual(
        installedInterfaces.createInterfaceProtocolCatalog().entries.map(
            entry => entry.protocol.id
        ),
        installedInterfaces.BUILTIN_INTERFACE_PROTOCOL_IDS
    );
    const installedProtocolLoader = readFileSync(path.join(
        installedPackage,
        'dist',
        'runtime',
        'interfaceProtocolLoader.js'
    ), 'utf8');
    for (const marker of [
        'parseInterfaceProtocolText',
        'createInterfaceProtocolCatalog',
        'IF_PROTOCOL_FILE_NOT_FOUND',
    ]) {
        assert.ok(
            installedProtocolLoader.includes(marker),
            `installed CLI protocol loader is missing ${marker}`
        );
    }
    const cliEntry = path.join(installedPackage, 'dist', 'main.js');
    const help = invokeCli(cliEntry, ['--help'], installRoot, environment);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /VeriFlow - Lightweight Verilog Simulation Manager/);
    const version = invokeCli(cliEntry, ['--version'], installRoot, environment);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `VeriFlow ${rootVersion}\n`);

    const projectRoot = path.join(installRoot, 'smoke-project');
    const rtlRoot = path.join(projectRoot, 'rtl');
    mkdirSync(rtlRoot, { recursive: true });
    writeFileSync(path.join(rtlRoot, 'child.sv'), 'module child; endmodule\n', 'utf8');
    writeFileSync(
        path.join(rtlRoot, 'top.sv'),
        'module top; child child_instance(); endmodule\n',
        'utf8'
    );
    writeFileSync(path.join(projectRoot, 'project.json'), JSON.stringify({
        project_name: 'release-smoke',
        project_root: 'rtl',
        top_module: 'top',
    }, null, 2), 'utf8');
    writeFileSync(path.join(projectRoot, 'soc.ad'), `${JSON.stringify({
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'soc',
        ports: [],
        instances: [{ name: 'u_child', module: 'child' }],
        connections: [],
        interfaceConnections: [],
        defaults: {},
        export: {},
        presentation: {},
    }, null, 2)}\n`, 'utf8');
    const analyze = invokeCli(
        cliEntry,
        ['analyze', '--project', 'project.json'],
        projectRoot,
        environment
    );
    assert.equal(analyze.status, 0, analyze.stderr);
    assert.match(analyze.stdout, /child\.sv/);
    assert.match(analyze.stdout, /top\.sv/);
    const validateAd = invokeCli(cliEntry, ['ad', 'validate', 'soc.ad'], projectRoot, environment);
    assert.equal(validateAd.status, 0, validateAd.stderr);
    const exportAd = invokeCli(cliEntry, ['ad', 'export', 'soc.ad'], projectRoot, environment);
    assert.equal(exportAd.status, 0, exportAd.stderr);
    assert.match(
        readFileSync(path.join(projectRoot, 'soc.v'), 'utf8'),
        /^\/\/ vik-veriflow:generated arch-design /
    );

    const interfaceProjectRoot = path.join(installRoot, 'interface-project');
    mkdirSync(path.join(interfaceProjectRoot, 'rtl'), { recursive: true });
    mkdirSync(path.join(interfaceProjectRoot, 'protocols'), { recursive: true });
    writeFileSync(path.join(interfaceProjectRoot, 'rtl', 'interface_master.v'), [
        'module interface_master(',
        '    output wire [31:0] BUS_REQUEST,',
        '    input wire BUS_ACCEPT',
        ');',
        'endmodule',
        '',
    ].join('\n'), 'utf8');
    writeFileSync(path.join(interfaceProjectRoot, 'rtl', 'interface_slave.v'), [
        'module interface_slave(',
        '    input wire [31:0] LINK_REQUEST,',
        '    output wire LINK_ACCEPT,',
        '    input wire [3:0] LINK_TAG',
        ');',
        'endmodule',
        '',
    ].join('\n'), 'utf8');
    writeFileSync(
        path.join(interfaceProjectRoot, 'protocols', 'link.json'),
        JSON.stringify({
            format: 'veriflow-interface-protocol',
            schemaVersion: 1,
            id: 'project.link',
            name: 'Project Link',
            separator: '_',
            priority: 100,
            members: [
                { name: 'request', direction: 'master-to-slave' },
                { name: 'accept', direction: 'slave-to-master', default: "1'b0" },
                { name: 'tag', direction: 'master-to-slave', default: "4'ha" },
            ],
            recognitionGroups: [['request', 'accept']],
        }, null, 2),
        'utf8'
    );
    writeFileSync(path.join(interfaceProjectRoot, 'project.json'), JSON.stringify({
        project_name: 'release-interface-smoke',
        project_root: 'rtl',
        top_module: 'interface_top',
        schematic: { interface_protocols: ['protocols/link.json'] },
    }, null, 2), 'utf8');
    writeFileSync(path.join(interfaceProjectRoot, 'interface.ad'), `${JSON.stringify({
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'interface_top',
        ports: [],
        instances: [
            { name: 'u_master', module: 'interface_master' },
            { name: 'u_slave', module: 'interface_slave' },
        ],
        connections: [],
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'LINK' },
        }],
        defaults: {},
        export: {},
        presentation: {},
    }, null, 2)}\n`, 'utf8');
    const validateInterfaceAd = invokeCli(cliEntry, [
        'ad', 'validate', 'interface.ad', '--project', 'project.json',
    ], interfaceProjectRoot, environment);
    assert.equal(validateInterfaceAd.status, 0, validateInterfaceAd.stderr);
    const exportInterfaceAd = invokeCli(cliEntry, [
        'ad', 'export', 'interface.ad', '--project', 'project.json',
    ], interfaceProjectRoot, environment);
    assert.equal(exportInterfaceAd.status, 0, exportInterfaceAd.stderr);
    const interfaceRtl = readFileSync(
        path.join(interfaceProjectRoot, 'interface.v'),
        'utf8'
    );
    assert.match(interfaceRtl, /^\/\/ vik-veriflow:generated arch-design /);
    assert.match(interfaceRtl, /\.LINK_TAG\(4'ha\)/);

    const simulationProjectRoot = path.join(installRoot, 'builtin-simulation-project');
    const simulationRtlRoot = path.join(simulationProjectRoot, 'rtl');
    const emptyPath = path.join(temporaryRoot, 'empty-path');
    mkdirSync(simulationRtlRoot, { recursive: true });
    mkdirSync(emptyPath);
    writeFileSync(path.join(simulationRtlRoot, 'counter.v'), [
        'module counter(input clk, input reset, output reg [3:0] value);',
        '  always @(posedge clk) begin',
        '    if (reset) value <= 0;',
        '    else value <= value + 1;',
        '  end',
        'endmodule',
        '',
    ].join('\n'));
    writeFileSync(path.join(simulationRtlRoot, 'counter_tb.v'), [
        '`timescale 1ns/1ps',
        'module counter_tb;',
        '  reg clk = 0;',
        '  reg reset = 1;',
        '  wire [3:0] value;',
        '  counter dut(.clk(clk), .reset(reset), .value(value));',
        '  always #5 clk = ~clk;',
        '  initial begin',
        '    $dumpfile("counter.vcd");',
        '    $dumpvars(0, counter_tb);',
        '    #12 reset = 0;',
        '    #40;',
        '    if (value === 4) $display("PASS");',
        '    else $display("FAIL value=%0d", value);',
        '    $finish;',
        '  end',
        'endmodule',
        '',
    ].join('\n'));
    writeFileSync(path.join(simulationProjectRoot, 'project.json'), JSON.stringify({
        project_name: 'release-builtin-smoke',
        project_root: 'rtl',
        top_module: 'counter_tb',
        simulator: 'builtin',
        wave_file_template: 'counter.vcd',
    }, null, 2));
    const simulation = invokeCli(
        cliEntry,
        ['sim', '--project', 'project.json', '--sim', 'builtin'],
        simulationProjectRoot,
        { ...environment, PATH: emptyPath }
    );
    assert.equal(simulation.status, 0, simulation.stderr || simulation.stdout);
    assert.match(simulation.stdout, /PASS/);
    assert.doesNotMatch(simulation.stdout, /\[CMD\]/);
    const waveFile = path.join(simulationRtlRoot, 'counter.vcd');
    assert.equal(readFileSync(waveFile).length > 0, true, 'builtin VCD must be non-empty');
    assert.match(installedProvenance.revision, /^[0-9a-f]{40}$/);
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Node release artifact smoke passed');
