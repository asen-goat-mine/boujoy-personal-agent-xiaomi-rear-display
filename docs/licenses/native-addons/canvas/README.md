# Canvas 1.0.11 native notices

This directory supplements the MIT license already shipped by `@napi-rs/canvas` and its Darwin arm64 native package. It preserves original license, copyright, and patent notices for the 107 components in the platform package's own CycloneDX SBOM, plus the pinned Skia source license. The upstream SBOM includes Rust build dependencies and target-specific entries as well as runtime code; preserving their notices does not assert that every entry is linked into this platform binary.

## Fixed source identities

- Canvas: [v1.0.11, commit adce718ec8ff82f9e896875752fd621c46b1c04e](https://github.com/Brooooooklyn/canvas/tree/adce718ec8ff82f9e896875752fd621c46b1c04e).
- Skia submodule: [95ee33d7ec7791ab9c071675710a14fe6408ae4f](https://github.com/google/skia/tree/95ee33d7ec7791ab9c071675710a14fe6408ae4f).
- `shipped-sbom.cdx.json` is an unmodified copy from the actual npm platform package. `sources.json` records every crate archive URL and checksum, every native dependency's exact repository commit and original notice URL, and a component-to-notice mapping.
- All 93 external Cargo source archives were fetched from the published crate registry and matched the SHA256 checksums in the shipped SBOM. Seven crates omit a standalone license in their archive; their repository-root notices were fetched at the exact `.cargo_vcs_info.json` commit. Skia's 12 declared enabled vendored dependencies have original notices at the exact SBOM commits.
- `source-evidence/` contains unmodified upstream source metadata and build/SBOM recipes for identifying dependencies. These are documents; they are not executed by this application.

## MPL source availability

The four MPL-2.0 crate sources are included unmodified, in complete published source archives under `mpl-sources/`: cssparser 0.38.0, cssparser-color 0.6.0, cssparser-macros 0.7.0, and dtoa-short 0.3.5. The `.tar.gz` files contain the original `.crate` bytes (the crate format is gzip-compressed tar); their hashes match the corresponding SBOM checksums. Each archive includes its original MPL notice. Recipients can extract, use, and modify that source under MPL-2.0. No fee or separate request is required. The exact original registry URLs are also recorded in `sources.json`.

## Attribution and scope

Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org/). All rights reserved. FreeType is distributed here under the FreeType License (FTL); the original dual-license documentation is retained for context. Independent components retain their own license terms, including BSD, MIT, Apache, Unicode, IJG, zlib, FTL, and MPL notices. No claim that every component is MIT is made.

Original upstream copyright names, email addresses, URLs, and example paths in these notices or source archives are upstream attribution and source content. They are not application-user data. This directory changes documentation only; it does not modify or rebuild the distributed native binary.
