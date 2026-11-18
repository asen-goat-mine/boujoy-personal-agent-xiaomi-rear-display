import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
test('Android builder keeps restored identity, rejects either missing half and never follows signing symlinks',()=>{
 const code=`
import importlib.util, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('boujoy_build', 'scripts/build-android.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='boujoy-signing-test-') as directory:
    module.RUNTIME = Path(directory) / 'runtime/build-tools/android'
    signing = module.RUNTIME / 'signing'
    signing.mkdir(parents=True)
    key, password = signing / 'boujoy-android.jks', signing / 'store-password'
    with patch.object(module, 'run') as run:
        for existing in (key, password):
            existing.write_text('synthetic')
            try:
                module.prepare_signing({'javaHome': '/unused'}, {})
                raise AssertionError('incomplete identity accepted')
            except RuntimeError as error:
                assert 'incomplete' in str(error)
            existing.unlink()
        key.write_bytes(b'original-fixed-key')
        password.write_text('synthetic-password')
        module.prepare_signing({'javaHome': '/unused'}, {})
        assert key.read_bytes() == b'original-fixed-key'
        assert password.read_text() == 'synthetic-password'
        assert key.stat().st_mode & 0o777 == 0o600
        assert password.stat().st_mode & 0o777 == 0o600
        assert signing.stat().st_mode & 0o777 == 0o700
        key.unlink()
        key.symlink_to(Path(directory) / 'missing')
        try:
            module.prepare_signing({'javaHome': '/unused'}, {})
            raise AssertionError('linked key accepted')
        except RuntimeError as error:
            assert 'symlinks' in str(error)
        run.assert_not_called()
print('restored signing identity verified without key generation')
`;
 const output=execFileSync('python3',['-B','-c',code],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'});assert.match(output,/verified without key generation/);
});
