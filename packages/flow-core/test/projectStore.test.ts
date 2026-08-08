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
        assert.equal(legacy.waveViewers.builtin.launchCmd, '');
        assert.equal(legacy.waveViewers.surfer.launchCmd, 'surfer "{wave_file}"');
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

test('project helpers resolve wave and testbench paths from the project root', () => {
    const project = new ProjectStore().create('demo', '/workspace/project');
    project.topModule = 'top';
    project.waveFileTemplate = 'waves/{top_module}.vcd';
    project.testbenchOutputDir = 'generated/tb';

    assert.equal(resolveWaveFile(project), '/workspace/project/waves/top.vcd');
    project.waveFileTemplate = '/tmp/external.vcd';
    assert.equal(resolveWaveFile(project), '/tmp/external.vcd');
    assert.equal(
        resolveTestbenchOutputDir(project),
        '/workspace/project/generated/tb'
    );
    project.testbenchOutputDir = '/tmp/generated';
    assert.equal(resolveTestbenchOutputDir(project), '/tmp/generated');
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
