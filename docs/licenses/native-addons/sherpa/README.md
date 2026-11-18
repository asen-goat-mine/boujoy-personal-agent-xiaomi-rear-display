# Sherpa-ONNX 1.13.8 native notices and source provenance

This directory covers the speech native libraries shipped by `sherpa-onnx-darwin-arm64` 1.13.8 and used through `sherpa-onnx-node`. The upstream Sherpa code is Apache-2.0; this is **not** a statement that the complete prebuilt native library is Apache-only. Its eSpeak NG component is GPLv3.

## Identified source and components

The upstream Sherpa version is pinned to [commit 11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf](https://github.com/k2-fsa/sherpa-onnx/tree/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf). `sources.json` records fixed source URLs, checked archive SHA256 values, original notice member hashes, actual native library hashes, and the build recipe files in `source-evidence/`. Original notices are preserved under `originals/`.

| Component | Identified version | License material retained |
| --- | --- | --- |
| Sherpa-ONNX | 1.13.8 / fixed commit above | Apache-2.0 |
| kaldi-native-fbank | 1.22.3 | Apache-2.0 |
| KISS FFT | febd4caeed32e33ad8b2e0bb5ea77542c40f18ec | BSD-3-Clause, original COPYING and LICENSES text |
| kaldi-decoder / kaldifst | 0.3.0 / 1.8.0 | Apache-2.0 |
| OpenFST | 1.8.5-2026-07-09 | Apache-2.0 and original notices |
| Eigen | 5.0.1 | MPL-2.0 and other original COPYING notices; complete unchanged source archive included under mpl-sources |
| simple-sentencepiece | 0.7 | Original BSD notice |
| nlohmann/json | 3.12.0 | MIT and original documentation notice |
| eSpeak NG for Piper | ed530aa113046142eb5115cf2fc9157854d0ffe1 | GPLv3 and original subsidiary notices |
| Piper phonemize | f3ff95afc03640bc1399e113e83361192a2fafb4 | MIT and bundled uni-algo notice |
| hclust-cpp | 2026-02-25 | Original two-clause BSD notice and named authors |
| ONNX Runtime | 1.28.2 | MIT plus the original complete ThirdPartyNotices.txt |
| node-addon-api header interface | upstream requested ^8.3.0 | MIT v8.3.0 notice; exact build-resolved patch version not proven |

The Sherpa root CMake module paths precede the nested decoder/FST paths, so its pinned Eigen and OpenFST recipes are the active recipes for the shared build. Test/Python bindings, WebSocket, PortAudio, Sonic, MBROLA and pcaudio are disabled by the supplied build recipe; they are not inferred to be shipped merely because their build definitions occur in a source archive. The actual `libonnxruntime.dylib` is byte-for-byte identical to the library in the SHA256-verified upstream 1.28.2 arm64 prebuilt archive.

## eSpeak GPL source delivery

The fixed upstream npm macOS workflow leaves TTS enabled. Its eSpeak recipe forces a static eSpeak build, and the actual distributed C API library contains eSpeak/Piper symbols. The original GPLv3 COPYING text is retained here. Treating the npm Apache license field as permission for every linked component would be incorrect.

The unchanged corresponding Sherpa, eSpeak, Piper and selected dependency source archives are included in this package, with fixed build recipes and the Node header sources. See [source delivery and reconstruction materials](SOURCE-BUILD.md) and `includedArchives` in `sources.json`. Recipients can access these files offline without requesting a separate source download. The distinct source-only and prebuilt-prerequisite entries are identified explicitly; source-delivery verification is not a blanket legal conclusion about every combined-work boundary.

The Node addon build uses a semver range for node-addon-api and does not commit a resolved lockfile. Its MIT attribution is supplied, but a byte-for-byte reproducible reconstruction of the complete native addon is not claimed. The original upstream workflow is supplied as evidence, not executed by Boujoy.

All names, emails, source paths, and URLs inside original upstream notices/source are upstream attribution or examples, not application-user data. No application runtime source or native binary was modified by this documentation addition.
