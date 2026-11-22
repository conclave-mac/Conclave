#!/bin/bash
# Prove delle funzioni pure dell'app Swift: compila i file puri di macos/ (solo Foundation) con
# le asserzioni di tests/swift/main.swift ed esegue il risultato. Uscita diversa da 0 se una prova fallisce.
set -euo pipefail
cd "$(dirname "$0")/../.."
SOURCES=(macos/MarkdownParser.swift macos/PureText.swift tests/swift/main.swift)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
xcrun swiftc -module-name ConclaveTests "${SOURCES[@]}" -o "$TMP/tests"
"$TMP/tests"
