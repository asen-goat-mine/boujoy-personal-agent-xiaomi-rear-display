# Librsvg Rust dependency source and notices

This is a source and notice preservation set for librsvg 2.63.2 in the macOS arm64 sharp/libvips bundle. It is **not** a measured list of code linked into the delivered dylib.

## Reproducible evidence

- Original librsvg archive SHA-256: `852b18e1a00b8605528825a27dc7748bff2a5dd254028f59dc22a34ea57e81b6`.
- Original `Cargo.lock` SHA-256: `e79e2a2735a0b5b151bb4133becd3008223fabedd34a8b787a872edab9854941`.
- All **357** crates.io packages in that original workspace lock are included as unchanged `.crate` source archives (38,675,419 bytes total). Every archive SHA-256 matches its lock entry.
- The workspace crates themselves remain in the accompanying full librsvg source archive; the exact root, library and C API Cargo manifests are also copied under `upstream/`.
- `locked-workspace-inventory.json` records declared license expressions, original authors, archive URLs/hashes, original notice files and separately identified upstream supplements. `package-manifests/` preserves parsed package metadata.

## Build scope and limits

- The fixed libvips recipe disables pixbuf, the command-line renderer and tests; removes GIF/WebP image features and Cairo PDF/PS features; and invokes `cargo update --workspace` before the locked C-library build. The original recipe excerpt and wrapper are included.
- Cargo documents that `update --workspace` keeps already locked non-workspace packages, updating other packages only when absent from the lock. See https://doc.rust-lang.org/cargo/commands/cargo-update.html#update-options .
- The upstream binary producer did not provide its post-edit Cargo.lock, resolved feature/target graph, or linker map here. Therefore we preserve a clearly marked locked-workspace source superset rather than invent a precise static-link SBOM.
- `dependency-scope.json` distinguishes 208 registry packages reachable through declared normal/build edges from 149 packages retained only for complete original-lock preservation. That reachability omits dev edges, but does not resolve every transitive feature or target condition; it must not be read as proof all those packages are linked.
- Fuzzers, benchmarks, test-only dependencies, disabled optional features and non-macOS target packages are not described as shipped runtime components merely because their source archive is retained.

## License and source material

- The complete locked sources for MPL-declared cssparser, cssparser-color, cssparser-macros, dtoa-short, mp4parse and selectors are included, together with their original notices/headers and the MPL-2.0 standard text.
- Standard MIT, Apache-2.0 and MPL-2.0 texts are included under `common-license-texts/` as references. Package-specific copyright statements and original author declarations remain in the unmodified archives and inventory.
- Some original published crates omit a separate named LICENSE file. Those cases are **not** represented as having one: the inventory marks `originalNoticeFileMissing`, preserves the actual source/manifest declarations, and distinguishes an exact recorded-VCS supplement from a later repository license snapshot. No copyright holder/year is invented.

## Packages whose published archive omitted a separate notice

| Package | Declared license | Additional evidence |
|---|---|---|
| anes 0.1.6 | MIT OR Apache-2.0 | exact crate-recorded VCS notice |
| block 0.1.6 | MIT | original package declaration/source headers + standard license reference |
| defmt-parser 1.0.0 | MIT OR Apache-2.0 | exact crate-recorded VCS notice |
| difflib 0.4.0 | MIT | supplemental repository license blob; see provenance |
| malloc_buf 0.0.6 | MIT | supplemental repository license blob; see provenance |
| mutants 0.0.4 | MIT | exact crate-recorded VCS notice |
| objc-foundation 0.1.1 | MIT | original package declaration/source headers + standard license reference |
| objc_id 0.1.1 | MIT | original package declaration/source headers + standard license reference |
| selectors 0.40.0 | MPL-2.0 | original package declaration/source headers + standard license reference |
| winapi-i686-pc-windows-gnu 0.4.0 | MIT/Apache-2.0 | supplemental repository license blob; see provenance |
| winapi-x86_64-pc-windows-gnu 0.4.0 | MIT/Apache-2.0 | supplemental repository license blob; see provenance |

## Verification

`SHA256SUMS` covers every file in this directory except itself. The source archive checksum in the inventory additionally ties each registry source to the original Cargo.lock. No Rust toolchain was installed and no third-party build script or source code was executed to prepare this set.
