import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
);
const editor = manifest.contributes.customEditors.find(
    (item: any) => item.viewType === 'veriflow.schematicEditor'
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
for (const id of ['veriflow.openSchematic', 'veriflow.openSchematicFromExplorer']) {
    assert.ok(
        manifest.contributes.commands.some((item: any) => item.command === id),
        `${id} command contribution is missing`
    );
}

console.log('schematic manifest tests passed');
