import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

type ParserAsset = {
    name: string;
    source: string;
    destination: string;
    sha256: string;
};

type BuildSupport = {
    verifyAndCopyParserAssets(assets: ParserAsset[]): Promise<void>;
};

const extensionRoot = path.resolve(__dirname, '..', '..');
const loadEsmModule = new Function(
    'specifier',
    'return import(specifier);'
) as (specifier: string) => Promise<BuildSupport>;
const sha256 = (value: string): string => createHash('sha256')
    .update(value)
    .digest('hex');

async function testParserAssetSafety(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-parser-assets-'));
    const firstSource = path.join(root, 'first-source.wasm');
    const secondSource = path.join(root, 'second-source.wasm');
    const firstDestination = path.join(root, 'media', 'first.wasm');
    const secondDestination = path.join(root, 'media', 'second.wasm');
    const firstContent = 'new-first-asset';
    const secondContent = 'bad-second-asset';
    const trustedFirst = 'trusted-first-asset';
    const trustedSecond = 'trusted-second-asset';

    try {
        fs.mkdirSync(path.dirname(firstDestination), { recursive: true });
        fs.writeFileSync(firstSource, firstContent);
        fs.writeFileSync(secondSource, secondContent);
        fs.writeFileSync(firstDestination, trustedFirst);
        fs.writeFileSync(secondDestination, trustedSecond);
        if (process.platform !== 'win32') {
            fs.chmodSync(firstSource, 0o755);
            fs.chmodSync(firstDestination, 0o644);
        }

        const support = await loadEsmModule(pathToFileURL(
            path.join(extensionRoot, 'scripts', 'build-support.mjs')
        ).href);
        const assets: ParserAsset[] = [
            {
                name: 'first',
                source: firstSource,
                destination: firstDestination,
                sha256: sha256(firstContent),
            },
            {
                name: 'second',
                source: secondSource,
                destination: secondDestination,
                sha256: sha256('expected-second-asset'),
            },
        ];

        await assert.rejects(
            () => support.verifyAndCopyParserAssets(assets),
            /second WASM SHA256 mismatch/
        );
        assert.strictEqual(fs.readFileSync(firstDestination, 'utf8'), trustedFirst);
        assert.strictEqual(fs.readFileSync(secondDestination, 'utf8'), trustedSecond);

        assets[1].sha256 = sha256(secondContent);
        await support.verifyAndCopyParserAssets(assets);
        assert.strictEqual(fs.readFileSync(firstDestination, 'utf8'), firstContent);
        assert.strictEqual(fs.readFileSync(secondDestination, 'utf8'), secondContent);
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(firstDestination).mode & 0o777, 0o644);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
}

testParserAssetSafety()
    .then(() => console.log('parser asset safety tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
