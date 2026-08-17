#!/usr/bin/env bash
# Compose the GitHub Release body for a release tag: the CHANGELOG entry for the
# version, the commit list for the tag range, and the compare link.
#
# Usage: scripts/release-notes.sh <tag> [<ref>]   (the body goes to stdout)
#
# With <ref> the tag need not exist yet: the entry and the commits are read at
# that ref, so a body can be reviewed before anything is tagged or built.
set -euo pipefail

die() {
    printf 'release-notes: %s\n' "$*" >&2
    exit 1
}

TAG="${1-}"
REF="${2-}"
[ -n "$TAG" ] || die "no tag given; usage: scripts/release-notes.sh <tag> [<ref>]"

# The tag shape picks the namespace. A repository may tag bare (2.1.0) or with
# a v prefix (v1.7.27), and a repository that runs both lines resolves each
# tag's previous tag among tags of its own shape, never crossing into the other.
case "$TAG" in
    v[0-9]*) MATCH='v*' EXCLUDE='v*-*' ;;
    [0-9]*) MATCH='[0-9]*' EXCLUDE='[0-9]*-*' ;;
    *) die "tag $TAG is neither a bare semver tag nor a v-prefixed one" ;;
esac

VERSION="${TAG#v}"
BASE="${VERSION%%-*}"

# A stable tag lists everything since the last stable tag, so the prereleases
# between the two are excluded from the lookup. A prerelease takes the nearest
# tag of any kind, which is the previous prerelease when there is one.
DESCRIBE=(--tags --abbrev=0 --match "$MATCH")
case "$VERSION" in
    *-*) ;;
    *) DESCRIBE+=(--exclude "$EXCLUDE") ;;
esac

if [ -n "$REF" ]; then
    git rev-parse -q --verify "$REF^{commit}" >/dev/null ||
        die "ref $REF does not resolve to a commit in this repository"
    SOURCE="$REF"
    FROM="$REF"
else
    git rev-parse -q --verify "refs/tags/$TAG" >/dev/null ||
        die "tag $TAG does not exist in this repository; pass a ref to preview it before tagging"
    SOURCE="$TAG"
    FROM="$TAG^"
fi

ORIGIN="$(git remote get-url origin 2>/dev/null)" ||
    die "this repository has no origin remote"
# Only the GitHub URL forms git emits or accepts; anything else is refused
# rather than parsed into a compare link that points at the wrong host.
case "$ORIGIN" in
    git@github.com:*) SLUG="${ORIGIN#git@github.com:}" ;;
    ssh://git@github.com/*) SLUG="${ORIGIN#ssh://git@github.com/}" ;;
    https://github.com/*) SLUG="${ORIGIN#https://github.com/}" ;;
    https://*@github.com/*) SLUG="${ORIGIN#https://*@github.com/}" ;;
    *) die "the origin remote is not a GitHub URL: $ORIGIN" ;;
esac
SLUG="${SLUG%/}"
SLUG="${SLUG%.git}"

# git describe exits non-zero when no tag matches. That is the first-release
# case rather than a failure, so the status is read here instead of aborting.
# A stable tag whose only earlier tags are prereleases falls back to the
# nearest tag of any kind, so the first stable release after a candidate line
# still lists what it adds to the last candidate.
PREV="$(git describe "${DESCRIBE[@]}" "$FROM" 2>/dev/null || true)"
[ -n "$PREV" ] ||
    PREV="$(git describe --tags --abbrev=0 --match "$MATCH" "$FROM" 2>/dev/null || true)"
[ -n "$PREV" ] ||
    die "no earlier $MATCH tag reachable from $FROM; the first-release body is written by hand"
# In preview mode the ref may already carry the tag being composed, in which
# case PREV would be the tag itself and the commit list empty.
[ "$PREV" != "$TAG" ] ||
    die "$TAG already tags $REF; drop the ref argument to compose the body for the tag"

# The CHANGELOG is read at the tag, not from the working tree, so the body
# describes what the tag ships, and a prerelease reads the entry for its base
# version as it stands there. The heading match is a prefix, so trailing text
# such as a date is ignored. sed drops the blank lines above the first line of
# content, and the command substitution ($(...)) drops the trailing ones.
ENTRY="$(git show "$SOURCE:CHANGELOG.md" | awk -v h="## [$BASE]" '
    !inside && ($0 == h || index($0, h " ") == 1) { inside = 1; next }
    inside && /^## / { exit }
    inside { print }
' | sed '/./,$!d')"
[ -n "$ENTRY" ] || die "CHANGELOG.md at $SOURCE has no \"## [$BASE]\" entry"

[ -z "$REF" ] ||
    printf 'release-notes: preview from %s, commits %s..%s\n' "$REF" "$PREV" "$REF" >&2

printf '%s\n' "$ENTRY" | sed 's/^### /## /'
printf '\n## Commits\n\n'
git --no-pager log --no-decorate --no-show-signature --reverse --oneline "$PREV..$SOURCE" | sed 's/^/- /'
printf '\nFull changelog: https://github.com/%s/compare/%s...%s\n' "$SLUG" "$PREV" "$TAG"
