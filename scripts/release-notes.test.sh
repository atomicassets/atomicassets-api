#!/usr/bin/env bash
# Paired test for scripts/release-notes.sh. Builds a throwaway git repository
# under mktemp -d, runs the script inside it, and asserts the propositions the
# release checklist rests on: the two tag namespaces, the previous-tag rule for
# a stable tag and for a prerelease, the pre-tag preview, and the failures.
#
# Usage: bash scripts/release-notes.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-notes.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CASES=0
PASSED=0

ok() {
    CASES=$((CASES + 1))
    PASSED=$((PASSED + 1))
    printf 'ok %s %s\n' "$CASES" "$1"
}

no() {
    CASES=$((CASES + 1))
    printf 'not ok %s %s\n    %s\n' "$CASES" "$1" "$2"
}

# The script under test runs as a separate process through its own shebang and
# executable bit, the way the checklist invokes it, so its errexit is not
# suppressed by this capture; RUN_RC carries the status explicitly.
RUN_OUT=""
RUN_RC=0
run() {
    RUN_RC=0
    RUN_OUT="$(scripts/release-notes.sh "$@" 2>&1)" || RUN_RC=$?
}

commit() {
    printf '%s\n' "$1" >>history.txt
    git add -A
    git commit -q -m "$1"
}

commit_lines() {
    printf '%s\n' "$RUN_OUT" |
        awk '/^## Commits$/ { inside = 1; next } inside && /^- / { n++ } END { print n + 0 }'
}

last_line() {
    printf '%s\n' "$RUN_OUT" | tail -n 1
}

# --- fixture -----------------------------------------------------------------

mkdir -p "$WORK/repo/scripts"
cp "$SCRIPT" "$WORK/repo/scripts/release-notes.sh"
chmod +x "$WORK/repo/scripts/release-notes.sh"
cd "$WORK/repo"

git -c init.defaultBranch=main init -q .
git config user.name "release-notes test"
git config user.email "release-notes-test@example.com"
git config commit.gpgsign false
git remote add origin https://github.com/example/repo.git

cat >CHANGELOG.md <<'EOF'
# Changelog

## [1.0.0] - 2026-01-01

The first stable release.
EOF
commit "feat: the first cut"
git tag v1.7.0

commit "fix: correct the coder"
git tag 1.0.0

cat >CHANGELOG.md <<'EOF'
# Changelog

## [1.1.0] - unreleased

The builder consumers asked for.

### Features

- A builder consumers can call without hand-rolling the payload. (#7)

## [1.0.0] - 2026-01-01

The first stable release.
EOF
commit "feat: add the builder (#7)"
git tag 1.1.0-rc1

# A temp-file rewrite rather than sed -i, whose in-place flag differs between
# GNU and BSD sed.
sed 's/^## \[1\.1\.0\] - unreleased$/## [1.1.0] - 2026-02-01/' CHANGELOG.md >CHANGELOG.md.new
mv CHANGELOG.md.new CHANGELOG.md
commit "chore(release): 1.1.0"
git tag 1.1.0

commit "chore: a version the changelog does not document"
git tag 1.1.1

cat >CHANGELOG.md <<'EOF'
# Changelog

## [1.2.0]

The entry the preview reads before the tag exists.

### Bug fixes

- The coder keeps the trailing byte. (#9)

## [1.1.0] - 2026-02-01

The builder consumers asked for.

### Features

- A builder consumers can call without hand-rolling the payload. (#7)

## [1.0.0] - 2026-01-01

The first stable release.
EOF
commit "docs: open the 1.2.0 entry"

git checkout -q -b release/1.7 v1.7.0
cat >CHANGELOG.md <<'EOF'
# Changelog

## [1.7.1] - 2026-01-05

The maintenance line takes the same fix.

### Bug fixes

- The coder keeps the trailing byte on the maintenance line. (#8)

## [1.0.0] - 2026-01-01

The first stable release.
EOF
commit "fix: keep the trailing byte (#8)"
git tag v1.7.1
git checkout -q main

# --- 1: a stable tag skips the prerelease between it and the last stable one --

run 1.1.0
want="$(git rev-list --count 1.0.0..1.1.0)"
got="$(commit_lines)"
if [ "$RUN_RC" -eq 0 ] &&
    [ "$(printf '%s\n' "$RUN_OUT" | head -n 1)" = "The builder consumers asked for." ] &&
    printf '%s\n' "$RUN_OUT" | grep -qx '## Features' &&
    ! printf '%s\n' "$RUN_OUT" | grep -qx '### Features' &&
    ! printf '%s\n' "$RUN_OUT" | grep -q '^## \[1\.1\.0\]' &&
    [ "$got" = "$want" ] &&
    [ "$(last_line)" = "Full changelog: https://github.com/example/repo/compare/1.0.0...1.1.0" ]; then
    ok "1.1.0 drops the entry heading, promotes the sections, lists $want commits since 1.0.0, and ends with the link"
else
    no "1.1.0 body" "rc=$RUN_RC commits=$got want=$want last='$(last_line)'"
fi

# --- 2: a prerelease reads the base-version entry and takes the nearest tag ---

run 1.1.0-rc1
want="$(git rev-list --count 1.0.0..1.1.0-rc1)"
got="$(commit_lines)"
if [ "$RUN_RC" -eq 0 ] &&
    printf '%s\n' "$RUN_OUT" | grep -qx '## Features' &&
    [ "$got" = "$want" ] &&
    [ "$(last_line)" = "Full changelog: https://github.com/example/repo/compare/1.0.0...1.1.0-rc1" ]; then
    ok "1.1.0-rc1 reads the [1.1.0] entry as it stands at the rc and lists the $want commit since 1.0.0"
else
    no "1.1.0-rc1 body" "rc=$RUN_RC commits=$got want=$want last='$(last_line)'"
fi

# --- 3: the v namespace resolves among v tags --------------------------------

run v1.7.1
want="$(git rev-list --count v1.7.0..v1.7.1)"
got="$(commit_lines)"
if [ "$RUN_RC" -eq 0 ] &&
    printf '%s\n' "$RUN_OUT" | grep -qx '## Bug fixes' &&
    [ "$got" = "$want" ] &&
    [ "$(last_line)" = "Full changelog: https://github.com/example/repo/compare/v1.7.0...v1.7.1" ]; then
    ok "v1.7.1 resolves the v namespace and links v1.7.0...v1.7.1"
else
    no "v1.7.1 body" "rc=$RUN_RC commits=$got want=$want last='$(last_line)'"
fi

# --- 4: the failures ---------------------------------------------------------

run 9.9.9
if [ "$RUN_RC" -ne 0 ] && printf '%s\n' "$RUN_OUT" | grep -q '9\.9\.9'; then
    ok "an unknown tag exits non-zero and names the tag"
else
    no "unknown tag" "rc=$RUN_RC out='$RUN_OUT'"
fi

run 1.1.1
if [ "$RUN_RC" -ne 0 ] &&
    printf '%s\n' "$RUN_OUT" | grep -q 'CHANGELOG' &&
    printf '%s\n' "$RUN_OUT" | grep -q '1\.1\.1'; then
    ok "a version with no CHANGELOG entry at its tag exits non-zero and names the version"
else
    no "missing CHANGELOG entry" "rc=$RUN_RC out='$RUN_OUT'"
fi

run 1.0.0
if [ "$RUN_RC" -ne 0 ] && printf '%s\n' "$RUN_OUT" | grep -q 'by hand'; then
    ok "the first tag in its namespace exits non-zero and sends the body to be written by hand"
else
    no "first tag in namespace" "rc=$RUN_RC out='$RUN_OUT'"
fi

run
if [ "$RUN_RC" -ne 0 ] && printf '%s\n' "$RUN_OUT" | grep -q 'no tag given'; then
    ok "no argument exits non-zero and names the missing tag"
else
    no "no argument" "rc=$RUN_RC out='$RUN_OUT'"
fi

# --- 5: a bare tag ignores a reachable v tag ---------------------------------

run 1.1.0
if [ "$RUN_RC" -eq 0 ] &&
    [ "$(last_line)" = "Full changelog: https://github.com/example/repo/compare/1.0.0...1.1.0" ] &&
    ! printf '%s\n' "$RUN_OUT" | grep -q 'v1\.7\.0'; then
    ok "1.1.0 ignores the reachable v1.7.0 and resolves PREV in the bare namespace"
else
    no "bare namespace isolation" "rc=$RUN_RC last='$(last_line)'"
fi

# --- 6: the pre-tag preview --------------------------------------------------

run 1.2.0 main
want="$(git rev-list --count 1.1.1..main)"
got="$(commit_lines)"
if [ "$RUN_RC" -eq 0 ] &&
    printf '%s\n' "$RUN_OUT" | grep -qx '## Bug fixes' &&
    [ "$got" = "$want" ] &&
    [ "$(last_line)" = "Full changelog: https://github.com/example/repo/compare/1.1.1...1.2.0" ]; then
    ok "1.2.0 main previews the body from the CHANGELOG at main and the $want commit since 1.1.1"
else
    no "preview from main" "rc=$RUN_RC commits=$got want=$want last='$(last_line)'"
fi

run 1.2.0
if [ "$RUN_RC" -ne 0 ] && printf '%s\n' "$RUN_OUT" | grep -q '1\.2\.0'; then
    ok "1.2.0 without a ref exits non-zero and names the absent tag"
else
    no "absent tag without a ref" "rc=$RUN_RC out='$RUN_OUT'"
fi

# --- 7: a preview from a ref that already carries the tag is refused --------

git tag 1.2.0
run 1.2.0 main
if [ "$RUN_RC" -ne 0 ] && printf '%s\n' "$RUN_OUT" | grep -q 'already tags'; then
    ok "1.2.0 main is refused once main carries the 1.2.0 tag"
else
    no "preview from a tagged ref" "rc=$RUN_RC out='$RUN_OUT'"
fi

# --- 8: a stable tag whose only earlier tags are prereleases takes the nearest -

git checkout -q --orphan candidates
{
    printf '%s\n' '# Changelog' '' '## [3.0.0]' '' 'A line that started with candidates.' '' '### Features' ''
    printf '%s\n' '- The first stable release of the line. (#20)'
} >CHANGELOG.md
commit "feat: start the 3.0 line"
git tag 3.0.0-rc1
commit "fix: the candidate fix (#20)"
git tag 3.0.0
run 3.0.0
if [ "$RUN_RC" -eq 0 ] &&
    [ "$(last_line)" = "Full changelog: https://github.com/example/repo/compare/3.0.0-rc1...3.0.0" ] &&
    [ "$(commit_lines)" = "1" ]; then
    ok "3.0.0 with only 3.0.0-rc1 before it falls back to the candidate and lists 1 commit"
else
    no "stable after only prereleases" "rc=$RUN_RC last='$(last_line)' commits=$(commit_lines)"
fi
git checkout -q main

printf 'passed %s/%s\n' "$PASSED" "$CASES"
[ "$PASSED" -eq "$CASES" ]
