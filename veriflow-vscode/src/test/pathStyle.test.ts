import * as assert from 'assert';

import { relativeDisplayPath } from '../core/pathStyle';

assert.strictEqual(
    relativeDisplayPath('/workspace/project', '/workspace/project/rtl/top.sv'),
    'rtl/top.sv'
);
assert.strictEqual(
    relativeDisplayPath('D:\\Software\\VeriFlow', 'D:\\Software\\VeriFlow\\rtl\\top.sv'),
    'rtl/top.sv'
);
assert.strictEqual(
    relativeDisplayPath('D:/Software/VeriFlow', 'D:\\Software\\VeriFlow\\ip\\alu.sv'),
    'ip/alu.sv'
);
assert.strictEqual(
    relativeDisplayPath('D:\\Software\\VeriFlow', 'E:\\shared\\alu.sv'),
    'E:/shared/alu.sv'
);
assert.strictEqual(
    relativeDisplayPath(
        '\\\\server\\share\\project',
        '\\\\server\\share\\project\\rtl\\top.sv'
    ),
    'rtl/top.sv'
);
assert.strictEqual(
    relativeDisplayPath(
        '\\\\server\\share\\project',
        '\\\\server\\other\\rtl\\top.sv'
    ),
    '//server/other/rtl/top.sv'
);
assert.strictEqual(
    relativeDisplayPath('/workspace/project', 'D:\\Software\\VeriFlow\\rtl\\top.sv'),
    'D:/Software/VeriFlow/rtl/top.sv'
);
assert.strictEqual(
    relativeDisplayPath('D:\\Software\\VeriFlow', '/workspace/project/rtl/top.sv'),
    '/workspace/project/rtl/top.sv'
);
assert.strictEqual(
    relativeDisplayPath('workspace/project', 'rtl\\top.sv'),
    'rtl/top.sv'
);
assert.strictEqual(
    relativeDisplayPath('/workspace/project', '/workspace/shared/alu.sv'),
    '/workspace/shared/alu.sv'
);
assert.strictEqual(
    relativeDisplayPath(
        '/workspace/project',
        '/workspace/shared/alu.sv',
        { allowOutsideRoot: true }
    ),
    '../shared/alu.sv'
);

console.log('path style tests passed');
