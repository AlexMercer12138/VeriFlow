import assert from 'node:assert/strict';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    DEFAULT_SIMULATORS,
    DEFAULT_WAVE_VIEWERS,
} from '@veriflow/flow-core/defaults';
import { GlobalConfigStore } from '@veriflow/flow-core/globalConfigStore';
import {
    resolveTestbenchOutputDir,
    resolveWaveFile,
} from '@veriflow/flow-core/project';
import { ProjectStore } from '@veriflow/flow-core/projectStore';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const projectFixture = path.join(
    repositoryRoot,
    'tests',
    'cli_contract',
    'fixtures',
    'project.json'
);

function temporaryDirectory(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('new projects expose only builtin and custom simulation choices', () => {
    const root = temporaryDirectory('veriflow-project-defaults-');
    try {
        const project = new ProjectStore().create('demo', root);

        assert.equal(project.simulator, 'builtin');
        assert.deepEqual(project.defines, {});
        assert.deepEqual(project.simulationFiles, []);
        assert.deepEqual(Object.keys(project.simulators), ['custom']);
        assert.deepEqual(Object.keys(project.waveViewers), ['builtin', 'custom']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project store loads current and legacy projects with defaults', () => {
    const root = temporaryDirectory('veriflow-project-load-');
    try {
        const currentFile = path.join(root, 'current', 'project.json');
        mkdirSync(path.dirname(currentFile), { recursive: true });
        cpSync(projectFixture, currentFile);

        const store = new ProjectStore();
        const current = store.open(currentFile);
        assert.equal(current.name, 'contract_demo');
        assert.equal(current.rootDir, path.join(root, 'current', 'rtl'));
        assert.deepEqual(current.libDirs, [path.join(root, 'current', 'libs', 'project')]);
        assert.equal(current.simulators.fake.compileCmd, 'fake-compile -o "{output}" {files}');
        assert.equal(current.simulators.iverilog.runCmd, DEFAULT_SIMULATORS.iverilog.runCmd);
        assert.equal(current.waveViewers.builtin.launchCmd, '');
        assert.equal(current.waveViewers.surfer.launchCmd, DEFAULT_WAVE_VIEWERS.surfer.launchCmd);
        assert.deepEqual(current.extra, { custom_metadata: { owner: 'contract' } });

        const legacyFile = path.join(root, 'legacy.json');
        writeFileSync(legacyFile, JSON.stringify({
            project_name: 'legacy',
            project_root: 'legacy-root',
            wave_viewer: 'surfer',
            simulators: {},
            wave_viewers: {
                surfer: 'surfer "{wave_file}"',
                gtkwave: 'gtkwave "{wave_file}"',
            },
        }));
        const legacy = store.open(legacyFile);
        assert.equal(legacy.rootDir, path.join(root, 'legacy-root'));
        assert.equal(legacy.topModule, '');
        assert.equal(legacy.simulator, 'iverilog');
        assert.deepEqual(legacy.defines, {});
        assert.deepEqual(legacy.simulationFiles, []);
        assert.equal(legacy.waveViewers.builtin.launchCmd, '');
        assert.equal(legacy.waveViewers.surfer.launchCmd, 'surfer "{wave_file}"');

        const explicitIverilogFile = path.join(root, 'explicit-iverilog.json');
        writeFileSync(explicitIverilogFile, JSON.stringify({
            project_name: 'external',
            simulator: 'iverilog',
        }));
        const explicitIverilog = store.open(explicitIverilogFile);
        assert.equal(explicitIverilog.simulator, 'iverilog');
        assert.deepEqual(explicitIverilog.simulators.iverilog, {
            name: 'iverilog',
            compileCmd: 'iverilog -o "{output}" {files}',
            runCmd: 'vvp "{output}"',
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project store resolves and round trips simulation inputs and unknown keys', () => {
    const root = temporaryDirectory('veriflow-project-simulation-inputs-');
    try {
        const sourceFile = path.join(root, 'configs', 'source.json');
        const savedFile = path.join(root, 'saved', 'project.json');
        mkdirSync(path.dirname(sourceFile), { recursive: true });
        writeFileSync(sourceFile, JSON.stringify({
            project_name: 'simulation-inputs',
            defines: {
                TARGET: 'fpga',
                WIDTH: 32,
                TRACE: true,
                DISABLED: false,
            },
            simulation_files: [
                '../runtime/firmware.hex',
                '../runtime/config.bin',
            ],
            future_simulation_option: { keep: true },
        }));

        const store = new ProjectStore();
        const project = store.open(sourceFile);
        assert.deepEqual(project.defines, {
            TARGET: 'fpga',
            WIDTH: 32,
            TRACE: true,
            DISABLED: false,
        });
        assert.deepEqual(project.simulationFiles, [
            path.join(root, 'runtime', 'firmware.hex'),
            path.join(root, 'runtime', 'config.bin'),
        ]);
        assert.deepEqual(project.extra, {
            future_simulation_option: { keep: true },
        });

        store.save(project, savedFile, { preserveUnknown: true });
        const saved = JSON.parse(readFileSync(savedFile, 'utf8'));
        assert.deepEqual(saved.defines, project.defines);
        assert.deepEqual(saved.simulation_files, [
            '../runtime/firmware.hex',
            '../runtime/config.bin',
        ]);
        assert.deepEqual(saved.future_simulation_option, { keep: true });

        const reopened = store.open(savedFile);
        assert.deepEqual(reopened.defines, project.defines);
        assert.deepEqual(reopened.simulationFiles, project.simulationFiles);
        assert.deepEqual(reopened.extra, project.extra);

        store.save(project, path.join(root, 'without-unknown.json'), {
            preserveUnknown: false,
        });
        const withoutUnknown = JSON.parse(readFileSync(
            path.join(root, 'without-unknown.json'),
            'utf8'
        ));
        assert.deepEqual(withoutUnknown.defines, project.defines);
        assert.deepEqual(withoutUnknown.simulation_files, [
            'runtime/firmware.hex',
            'runtime/config.bin',
        ]);
        assert.equal('future_simulation_option' in withoutUnknown, false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project store saves snake case, relative paths, exact JSON, and unknown keys', () => {
    const root = temporaryDirectory('veriflow-project-save-');
    try {
        const sourceFile = path.join(root, 'source', 'project.json');
        const savedFile = path.join(root, 'configs', 'saved.json');
        mkdirSync(path.dirname(sourceFile), { recursive: true });
        cpSync(projectFixture, sourceFile);

        const store = new ProjectStore();
        const project = store.open(sourceFile);
        project.topModule = 'replacement_top';
        store.save(project, savedFile);

        const raw = readFileSync(savedFile, 'utf8');
        const saved = JSON.parse(raw);
        assert.equal(raw, JSON.stringify(saved, null, 2));
        assert.equal(raw.endsWith('\n'), false);
        assert.deepEqual(Object.keys(saved), [
            'project_name',
            'project_root',
            'lib_dirs',
            'top_module',
            'simulator',
            'wave_viewer',
            'wave_file_template',
            'testbench_output_dir',
            'simulators',
            'wave_viewers',
            'file_order',
            'defines',
            'simulation_files',
            'analyze_status',
            'simulate_status',
            'custom_metadata',
        ]);
        assert.equal(saved.project_root, '../source/rtl');
        assert.deepEqual(saved.lib_dirs, ['../source/libs/project']);
        assert.equal(saved.top_module, 'replacement_top');
        assert.deepEqual(saved.custom_metadata, { owner: 'contract' });

        const compatibilityFile = path.join(root, 'configs', 'compatibility.json');
        store.save(project, compatibilityFile, { preserveUnknown: false });
        assert.equal('custom_metadata' in JSON.parse(readFileSync(compatibilityFile, 'utf8')), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project store resolves and round trips schematic interface protocol paths', () => {
    const root = temporaryDirectory('veriflow-project-protocols-');
    try {
        const sourceFile = path.join(root, 'configs', 'project.json');
        const savedFile = path.join(root, 'saved', 'project.json');
        mkdirSync(path.dirname(sourceFile), { recursive: true });
        writeFileSync(sourceFile, JSON.stringify({
            project_name: 'interfaces',
            schematic: {
                interface_protocols: [
                    '../protocols/link.json',
                    '../protocols/vendor/custom.json',
                ],
                future_option: { keep: true },
            },
            custom_metadata: true,
        }));

        const store = new ProjectStore();
        const project = store.open(sourceFile);

        assert.deepEqual(project.interfaceProtocolFiles, [
            path.join(root, 'protocols', 'link.json'),
            path.join(root, 'protocols', 'vendor', 'custom.json'),
        ]);
        assert.deepEqual(project.extra, { custom_metadata: true });
        assert.deepEqual(project.schematicExtra, {
            future_option: { keep: true },
        });

        store.save(project, savedFile);
        const saved = JSON.parse(readFileSync(savedFile, 'utf8'));
        assert.deepEqual(saved.schematic, {
            interface_protocols: [
                '../protocols/link.json',
                '../protocols/vendor/custom.json',
            ],
            future_option: { keep: true },
        });
        assert.equal('schematic' in project.extra, false);

        const legacy = store.create('legacy', root);
        assert.deepEqual(legacy.interfaceProtocolFiles, []);
        assert.deepEqual(legacy.schematicExtra, {});
        store.save(legacy, path.join(root, 'legacy.json'));
        assert.equal('schematic' in JSON.parse(
            readFileSync(path.join(root, 'legacy.json'), 'utf8')
        ), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project store safely preserves a __proto__ unknown key', () => {
    const root = temporaryDirectory('veriflow-project-special-key-');
    try {
        const sourceFile = path.join(root, 'source.json');
        const savedFile = path.join(root, 'saved.json');
        writeFileSync(
            sourceFile,
            '{"project_name":"special","__proto__":{"keep":true}}'
        );

        const store = new ProjectStore();
        const project = store.open(sourceFile);
        assert.deepEqual(Object.keys(project.extra), ['__proto__']);

        store.save(project, savedFile);
        const saved = JSON.parse(readFileSync(savedFile, 'utf8'));
        assert.deepEqual(saved.__proto__, { keep: true });
        assert.equal(Object.getPrototypeOf(saved), Object.prototype);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project helpers resolve wave and testbench paths from the project root', () => {
    const root = temporaryDirectory('veriflow-project-paths-');
    try {
        const projectRoot = path.join(root, 'workspace', 'project');
        const project = new ProjectStore().create('demo', projectRoot);
        project.topModule = 'top';
        project.waveFileTemplate = 'waves/{top_module}.vcd';
        project.testbenchOutputDir = 'generated/tb';

        assert.equal(resolveWaveFile(project), path.join(projectRoot, 'waves', 'top.vcd'));
        const externalWave = path.join(root, 'external.vcd');
        project.waveFileTemplate = externalWave;
        assert.equal(resolveWaveFile(project), externalWave);
        assert.equal(
            resolveTestbenchOutputDir(project),
            path.join(projectRoot, 'generated', 'tb')
        );
        const externalOutput = path.join(root, 'generated');
        project.testbenchOutputDir = externalOutput;
        assert.equal(resolveTestbenchOutputDir(project), externalOutput);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project store rejects invalid project field shapes', () => {
    const root = temporaryDirectory('veriflow-project-invalid-');
    try {
        const filepath = path.join(root, 'project.json');
        writeFileSync(filepath, JSON.stringify({
            project_name: 'invalid',
            project_root: [],
            lib_dirs: 'rtl',
        }));
        assert.throws(() => new ProjectStore().open(filepath), /project_root/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('project store rejects incomplete simulator and wave viewer entries', () => {
    const root = temporaryDirectory('veriflow-project-invalid-config-');
    try {
        const filepath = path.join(root, 'project.json');
        writeFileSync(filepath, JSON.stringify({
            simulators: { broken: { compile_cmd: 'compile' } },
        }));
        assert.throws(() => new ProjectStore().open(filepath), /run_cmd/);

        writeFileSync(filepath, JSON.stringify({
            wave_viewers: { broken: {} },
        }));
        assert.throws(() => new ProjectStore().open(filepath), /launch_cmd/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('global config store uses injected home, preserves keys, and writes Python bytes', () => {
    const homeDir = temporaryDirectory('veriflow-global-config-');
    try {
        const store = new GlobalConfigStore({ homeDir });
        assert.deepEqual(store.load(), {
            version: '1.1.0',
            lib_dirs: [],
            language: 'zh',
            theme: 'dark',
        });

        writeFileSync(store.configPath, JSON.stringify({
            version: '1.1.0',
            lib_dirs: ['/tmp/lib1'],
            language: 'zh',
            theme: 'dark',
            custom: { keep: true },
        }));
        store.addLibDir('/tmp/lib1');
        store.addLibDir('/tmp/lib2');
        store.removeLibDir('/tmp/lib1');
        store.setLanguage('en');
        store.setTheme('light');

        assert.deepEqual(store.getLibDirs(), ['/tmp/lib2']);
        const raw = readFileSync(store.configPath, 'utf8');
        assert.equal(raw.endsWith('\n'), false);
        assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2));
        assert.deepEqual(JSON.parse(raw), {
            version: '1.1.0',
            lib_dirs: ['/tmp/lib2'],
            language: 'en',
            theme: 'light',
            custom: { keep: true },
        });

        writeFileSync(store.configPath, '{invalid json');
        assert.deepEqual(store.load().lib_dirs, []);
    } finally {
        rmSync(homeDir, { recursive: true, force: true });
    }
});
