# Koffi 3.1.1 native notices

The Darwin arm64 platform package is paired with the `koffi` 3.1.1 parent package. The parent already contains the Koffi MIT license and the MIT licenses for its bundled node-addon-api and node-api-headers sources. The absence of another LICENSE inside the platform-only package is therefore not, by itself, a missing Koffi license. This directory copies those original notices for the distribution's central license index.

The parent archive is [koffi-3.1.1.tgz](https://registry.npmjs.org/koffi/-/koffi-3.1.1.tgz), published by the [Koffi project](https://github.com/Koromix/koffi). Its npm integrity was verified, and the three original license files plus `lib/native/base/unicode.inc` exactly match the installed package. `sources.json` records the source archive and member hashes.

The shipped generated Unicode table identifies Unicode 16.0.0 DerivedCoreProperties data. The exact versioned source header and data URL are recorded here, and the original Unicode License V3 is supplied in addition to the Koffi code license. The data header is copyright 2024; the currently retrieved official license text's copyright 1991–2026 is preserved unchanged. These are upstream attribution names, not application-user information.

The Koffi ABI implementation and base sources carry Koffi MIT headers. Its two vendored Node header libraries retain their own MIT notices. No libffi license has been inferred merely from the use of foreign-function calls. This documentation does not alter the native addon, interpreter, or application code.
