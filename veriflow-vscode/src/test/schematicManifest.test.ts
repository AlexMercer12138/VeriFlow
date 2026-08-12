import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
);
const extensionSource = fs.readFileSync(
    path.join(extensionRoot, 'src', 'extension.ts'),
    'utf8'
);
const editor = manifest.contributes.customEditors.find(
    (item: any) => item.viewType === 'veriflow.schematicEditor'
);
const archDesignEditor = manifest.contributes.customEditors.find(
    (item: any) => item.viewType === 'veriflow.archDesignEditor'
);
const explorerCommand = (manifest.contributes.menus['explorer/context'] ?? []).find(
    (item: any) => item.command === 'veriflow.openSchematicFromExplorer'
);
const editorTitleCommand = (manifest.contributes.menus['editor/title'] ?? []).find(
    (item: any) => item.command === 'veriflow.openSchematic'
);

assert.ok(explorerCommand, 'Explorer schematic command menu contribution is missing');
assert.match(explorerCommand.when, /resourceExtname\s*==\s*\.v\b/);
assert.match(explorerCommand.when, /resourceExtname\s*==\s*\.sv\b/);
assert.ok(editorTitleCommand, 'editor-title schematic command menu contribution is missing');
assert.match(editorTitleCommand.when, /editorLangId\s*==\s*verilog\b/);
assert.match(editorTitleCommand.when, /editorLangId\s*==\s*systemverilog\b/);
assert.ok(editor, 'schematic custom editor contribution is missing');
assert.strictEqual(editor.priority, 'option');
assert.deepStrictEqual(
    editor.selector.map((item: any) => item.filenamePattern),
    ['*.v', '*.sv']
);
assert.ok(archDesignEditor, 'Arch Design custom editor contribution is missing');
assert.strictEqual(archDesignEditor.priority, 'default');
assert.deepStrictEqual(
    archDesignEditor.selector.map((item: any) => item.filenamePattern),
    ['*.ad']
);
assert.ok(
    manifest.activationEvents.includes('onCustomEditor:veriflow.archDesignEditor'),
    'Arch Design custom editor activation is missing'
);
const archDesignLanguage = (manifest.contributes.languages ?? []).find(
    (item: any) => item.id === 'arch-design'
);
assert.ok(archDesignLanguage, 'Arch Design language contribution is missing');
assert.deepStrictEqual(archDesignLanguage.extensions, ['.ad']);
for (const id of ['veriflow.validateArchDesign', 'veriflow.exportArchDesign']) {
    assert.ok(
        manifest.contributes.commands.some((item: any) => item.command === id),
        `${id} command contribution is missing`
    );
    assert.ok(
        (manifest.contributes.menus['editor/title'] ?? []).some(
            (item: any) => item.command === id && /resourceExtname\s*==\s*\.ad/.test(item.when)
        ),
        `${id} editor-title contribution is missing`
    );
}
assert.match(
    extensionSource,
    /\['veriflow\.validateArchDesign',[\s\S]*?archDesignEditorProvider\.validate/
);
assert.match(
    extensionSource,
    /\['veriflow\.exportArchDesign',[\s\S]*?archDesignEditorProvider\.exportRtl/
);
for (const id of ['veriflow.openSchematic', 'veriflow.openSchematicFromExplorer']) {
    assert.ok(
        manifest.contributes.commands.some((item: any) => item.command === id),
        `${id} command contribution is missing`
    );
}

console.log('schematic manifest tests passed');
