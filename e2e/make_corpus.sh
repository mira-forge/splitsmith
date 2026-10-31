#!/bin/bash
# Builds the Gate 3 test corpus vault from public Markdown only (no personal vaults):
#   Help/en, Help/ja, Help/ar  - Obsidian's own help vault (github.com/obsidianmd/obsidian-help): wikilinks,
#                                heading/block links, embeds, callouts, frontmatter; Japanese and Arabic text.
#   Rust book                  - The Rust Programming Language (github.com/rust-lang/book, MIT/Apache-2.0):
#                                long chapters, fenced code full of '#' lines that are not headings.
#   CRLF                       - 30 Help/en notes converted to CRLF line endings (Windows-made vaults).
# Usage: make_corpus.sh <vault dir> [source dir, default /workspace/corpus]
set -euo pipefail
V="${1:?vault dir}"; S="${2:-/workspace/corpus}"
[ -e "$V" ] && { echo "refusing: $V exists"; exit 2; }
[ -d "$S/obsidian-help/en" ] || git clone -q --depth 1 https://github.com/obsidianmd/obsidian-help.git "$S/obsidian-help"
[ -d "$S/rust-book/src" ] || git clone -q --depth 1 https://github.com/rust-lang/book.git "$S/rust-book"
mkdir -p "$V"
cpmd() { python3 -c 'import os,shutil,sys
src,dst=sys.argv[1:]
for r,_,fs in os.walk(src):
  for f in fs:
    if f.endswith(".md"):
      d=os.path.join(dst,os.path.relpath(r,src)); os.makedirs(d,exist_ok=True); shutil.copy2(os.path.join(r,f),d)' "$1" "$2"; }
for l in en ja ar; do cpmd "$S/obsidian-help/$l" "$V/Help/$l"; done
cpmd "$S/rust-book/src" "$V/Rust book"
mkdir -p "$V/CRLF"
find "$V/Help/en" -name '*.md' -size +3k | LC_ALL=C sort | head -30 | while read -r f; do
  b=$(basename "$f" .md); sed 's/$/\r/' "$f" > "$V/CRLF/$b (CRLF).md"; done
echo "corpus: $(find "$V" -name '*.md' | wc -l) notes, $(du -sh "$V" | cut -f1)"
(cd "$S/obsidian-help" && echo "obsidian-help $(git rev-parse --short HEAD)"; cd "$S/rust-book" && echo "rust-book $(git rev-parse --short HEAD)") > "$V/../corpus_sources.txt"
