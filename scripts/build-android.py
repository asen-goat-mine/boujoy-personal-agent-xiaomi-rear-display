#!/usr/bin/env python3
"""Build/sign Boujoy Android with an isolated, checksum-pinned toolchain outside the Vault.

No device installation, cloud deployment, system Java registration or phone pairing occurs.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DISTRIBUTION = json.loads((Path(__file__).resolve().parents[1] / 'distribution.json').read_text())
DEFAULT_DATA = Path.home() / 'Library/Application Support' / DISTRIBUTION['dataDirectoryName']
RUNTIME = Path(os.environ.get('BOUJOY_DATA', DEFAULT_DATA)) / 'build-tools/android'
JDK_SHA = 'ed54397260c5994b2fc4e31c780f480b947e6532bc6a5ac7754355d5dd4c127d'
SDK_SHA = '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e'
GRADLE_SHA = 'f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6'

def download(name, urls, digest):
    target = RUNTIME / 'downloads' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
        return target
    for url in urls:
        try:
            print('Downloading', name, flush=True)
            with urllib.request.urlopen(url, timeout=45) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise RuntimeError('SHA-256 mismatch for ' + name)
            return target
        except Exception as error:
            target.unlink(missing_ok=True)
            last_error = error
    raise last_error

def prepare():
    config = RUNTIME / 'toolchain.json'
    if config.exists():
        value = json.loads(config.read_text())
        if all(Path(value[k]).exists() for k in ('javaHome', 'sdkRoot', 'gradle')):
            return value
    if os.uname().sysname != 'Darwin' or os.uname().machine != 'arm64':
        raise RuntimeError('This pinned bootstrap targets Apple Silicon macOS; configure a compatible toolchain.json for another build host.')
    jdk = download('jdk17-zulu.tar.gz', ['https://cdn.azul.com/zulu/bin/zulu17.68.203-ca-jdk17.0.20.1-macosx_aarch64.tar.gz'], JDK_SHA)
    with tarfile.open(jdk) as archive:
        archive.extractall(RUNTIME / 'jdk', filter='data')
    sdk = download('commandline.zip', ['https://dl.google.com/android/repository/commandlinetools-mac_arm64-15859902_latest.zip'], SDK_SHA)
    with zipfile.ZipFile(sdk) as archive:
        archive.extractall(RUNTIME / 'sdk/cmdline-tools/package')
    gradle = download('gradle-mirror.zip', [
        'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip',
        'https://mirrors.cloud.tencent.com/gradle/gradle-8.11.1-bin.zip',
    ], GRADLE_SHA)
    with zipfile.ZipFile(gradle) as archive:
        archive.extractall(RUNTIME / 'gradle')
    for folder in (RUNTIME / 'gradle', RUNTIME / 'sdk/cmdline-tools/package'):
        for file in folder.glob('**/bin/*'):
            if file.is_file():
                file.chmod(file.stat().st_mode | 0o111)
    value = {'javaHome': str(next((RUNTIME / 'jdk').glob('*/Contents/Home'))),
             'sdkRoot': str(RUNTIME / 'sdk'), 'gradle': str(RUNTIME / 'gradle/gradle-8.11.1/bin/gradle'),
             'gradleSha256': GRADLE_SHA}
    config.write_text(json.dumps(value, indent=2))
    return value

def run(args, env, **kwargs):
    subprocess.run([str(a) for a in args], env=env, check=True, **kwargs)

def prepare_signing(toolchain, env):
    signing = RUNTIME / 'signing'
    for component in (signing, *signing.parents):
        if component.is_symlink() and not (str(component) in ('/var', '/tmp', '/etc') and str(component.resolve()) == '/private' + str(component)):
            raise RuntimeError('Signing identity path must not contain symlinks.')
    signing.mkdir(mode=0o700, parents=True, exist_ok=True)
    signing.chmod(0o700)
    password_file = signing / 'store-password'
    key = signing / 'boujoy-android.jks'
    if key.is_symlink() or password_file.is_symlink():
        raise RuntimeError('Signing credentials must not be symlinks.')
    if key.exists() != password_file.exists():
        raise RuntimeError('Signing identity is incomplete; restore both original keystore and password instead of replacing the established application identity.')
    if key.exists() and (not key.is_file() or not password_file.is_file()):
        raise RuntimeError('Signing credentials must be regular files.')
    if not key.exists():
        password_file.write_text(secrets.token_urlsafe(36))
        password_file.chmod(0o600)
        run([Path(toolchain['javaHome']) / 'bin/keytool', '-genkeypair', '-keystore', key,
             '-storetype', 'PKCS12', '-storepass:file', password_file, '-keypass:file', password_file,
             '-alias', 'boujoy-android', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '3650',
             '-dname', 'CN=' + DISTRIBUTION['productName'] + ',O=Boujoy Open Source'], env)
    key.chmod(0o600)
    password_file.chmod(0o600)
    return key, password_file

def android_source_inputs():
    files = [p for p in (ROOT / 'android/app/src').rglob('*') if p.is_file()]
    files += [ROOT / name for name in ('android/app/build.gradle', 'android/build.gradle', 'android/settings.gradle', 'android/gradle.properties', 'distribution.json')]
    result = {}
    for file in sorted(files):
        if file.is_symlink():
            raise RuntimeError('Android input must not be a symlink: ' + str(file.relative_to(ROOT)))
        result[file.relative_to(ROOT).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return dict(sorted(result.items()))

def main():
    global RUNTIME
    parser = argparse.ArgumentParser()
    parser.add_argument('--test', action='store_true', help='Run JVM unit tests before release assembly')
    parser.add_argument('--runtime', type=Path, help='Use this isolated runtime directory for tools and the restored signing identity')
    args = parser.parse_args()
    if args.runtime:
        if not args.runtime.is_absolute():
            parser.error('--runtime must be an absolute directory')
        RUNTIME = args.runtime / 'build-tools/android'
    os.umask(0o077)
    toolchain = prepare()
    env = os.environ.copy()
    env.update(JAVA_HOME=toolchain['javaHome'], ANDROID_HOME=toolchain['sdkRoot'],
               GRADLE_USER_HOME=str(RUNTIME / 'gradle-cache'))
    sdk = Path(toolchain['sdkRoot'])
    manager = sdk / 'cmdline-tools/package/cmdline-tools/bin/sdkmanager'
    if not (sdk / 'platforms/android-35/android.jar').exists() or not (sdk / 'build-tools/35.0.0/apksigner').exists():
        with (RUNTIME / 'sdk-licenses.log').open('w') as log:
            run([manager, '--sdk_root=' + str(sdk), '--licenses'], env, input='y\n'*100, text=True, stdout=log, stderr=subprocess.STDOUT)
        run([manager, '--sdk_root=' + str(sdk), 'platforms;android-35', 'build-tools;35.0.0'], env)
    key, password_file = prepare_signing(toolchain, env)
    env.update(BOUJOY_ANDROID_KEYSTORE=str(key), BOUJOY_ANDROID_STORE_PASSWORD=password_file.read_text())
    inputs_before = android_source_inputs()
    command = [toolchain['gradle'], '--no-daemon', '--console=plain']
    if args.test:
        command += ['testReleaseUnitTest']
    command += ['assembleRelease']
    run(command, env, cwd=ROOT / 'android')
    apk = ROOT / 'android/app/build/outputs/apk/release/app-release.apk'
    run([sdk / 'build-tools/35.0.0/apksigner', 'verify', '--verbose', '--print-certs', apk], env)
    target = ROOT / 'dist/android'
    target.mkdir(parents=True, exist_ok=True)
    badging = subprocess.check_output([str(sdk / 'build-tools/35.0.0/aapt2'), 'dump', 'badging', str(apk)], env=env, text=True)
    package = re.search(rf"^package: name='{re.escape(DISTRIBUTION['androidApplicationId'])}' versionCode='(\d+)' versionName='([^']+)'", badging, re.M)
    if not package:
        raise RuntimeError('Signed APK version metadata is unavailable.')
    version_code, version = int(package[1]), package[2]
    if version != DISTRIBUTION['androidVersion'] or version_code != DISTRIBUTION['androidVersionCode']:
        raise RuntimeError('APK version does not match distribution identity')
    if android_source_inputs() != inputs_before:
        raise RuntimeError('Android source changed during build; artifact not accepted')
    output = target / ('Boujoy-Android-' + version + '.apk')
    shutil.copy2(apk, output)
    report = {'artifact': output.name, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
              'bytes': output.stat().st_size, 'applicationId': DISTRIBUTION['androidApplicationId'], 'edition': DISTRIBUTION['edition'],
              'version': version, 'versionCode': version_code, 'buildType': 'release', 'installedOnDevice': False,
              'androidSourceInputs': inputs_before,
              'androidSourceDigest': hashlib.sha256(json.dumps(inputs_before, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest(),
              'toolchain': {'jdk': JDK_SHA, 'gradle': GRADLE_SHA, 'sdkCommandLine': SDK_SHA}}
    (target / 'build-report.json').write_text(json.dumps(report, indent=2) + '\n')
    (apk.parent / 'boujoy-build-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print('Signed release APK:', output)
    print('SHA-256:', report['sha256'])

if __name__ == '__main__':
    main()
