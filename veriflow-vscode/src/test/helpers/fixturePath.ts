import * as path from 'path';

export function fixturePath(...segments: string[]): string {
    return path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', ...segments);
}
