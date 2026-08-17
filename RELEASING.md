# Releasing atomicassets-api

How a version of this project reaches GHCR and GitHub Releases. A release ends
at a rendered GitHub Release, not at the pushed tag.

Two lines are released in parallel. The 2.x line lives on `main` and is tagged
with bare semver (`2.1.0`, `2.0.0-rc9`). The 1.7 maintenance line lives on
`release/1.7` and is tagged with the `v` prefix (`v1.7.27`). The shape of the
tag is what selects the line, in the release workflow and in
`scripts/release-notes.sh` alike.

## Checklist

1. The feature PR carries the `CHANGELOG.md` entry for the version under
   `## [X.Y.Z]`, written in the section shape below with H3 headings, and lands
   on the branch that will be tagged: `main` for a 2.x release, `release/1.7`
   for a 1.7 release. The entry is the editorial text of the Release, so it is
   written once, in the PR that makes the change.

2. Land a `chore(release): X.Y.Z` commit on that branch that bumps the version
   in `package.json`.

3. Preview the body before anything is tagged:

    ```sh
    scripts/release-notes.sh X.Y.Z main
    scripts/release-notes.sh vX.Y.Z release/1.7
    ```

    The preview composes the body from the `CHANGELOG.md` entry at that branch
    and the commits since the previous tag, and it fails when the entry is
    missing. It does not check the section names, so read the preview against
    the template below now, because the next step publishes an image.

    A change that touches a migration or the filler goes out as an
    `X.Y.Z-rcN` tag first: rc images are what test deployments soak, and the
    stable tag follows once it holds.

4. Tag the release commit and push the tag:

    ```sh
    git tag X.Y.Z && git push origin X.Y.Z          # 2.x, on main
    git tag vX.Y.Z && git push origin vX.Y.Z        # 1.7, on release/1.7
    ```

    `.github/workflows/release.yaml` builds `ghcr.io/atomicassets/atomicassets-api`
    at `X.Y.Z` and `X.Y`, and moves `latest` for a stable 2.x tag. The image tag
    drops the `v`, so git `v1.7.28` publishes image `1.7.28`. The tag is the
    release: downstream deployments pin or float on those image tags, so push it
    only when you are ready to support that image.

5. Compose the body, read it, then create the Release:

    ```sh
    scripts/release-notes.sh X.Y.Z > notes.md
    gh release create X.Y.Z --verify-tag --title X.Y.Z --notes-file notes.md
    ```

    A 1.7 release runs the same two commands with its `vX.Y.Z` tag.

    Add `--prerelease` for an `-rc` tag, so the prerelease does not become the
    repository's latest Release. Add `--latest=false` when the Release is for a
    tag older than the current latest one, so the latest marker does not move
    backwards. With more than one release in flight, create them in ascending
    version order.

    `scripts/release-notes.sh` and this file live on `main`, and tags are
    repository-wide, so run the script from a `main` checkout for either line.

6. Verify the image and the Release:

    ```sh
    docker manifest inspect ghcr.io/atomicassets/atomicassets-api:X.Y.Z
    gh release view X.Y.Z
    ```

    The Release should render the sections, the commit list and the compare
    link.

Rollback for a deployment that already pulled the image: pin the previous image
tag, which stays published. A migration that already ran is not undone by a
repin; see [UPGRADING.md](./UPGRADING.md).

## Body template

The Release title is the tag name verbatim. The body is an optional
one-sentence summary, then the sections that have items, then the commit list,
then the compare link as the last line. Nothing follows the link, and a section
with no items is left out.

```
<one-sentence summary, optional>

## Breaking changes

- <what changed, and what the reader does about it>. (#N)

## Upgrading

- <what the move from the previous stable release takes: migrations, configuration keys, image tags>.

## Features

- <what is new>. (#N)

## Bug fixes

- <what was wrong and is not now>. (#N)

## Security

- <the advisory or the dependency lift, named>. (#N)

## Deprecations

- <what is deprecated and what replaces it>. (#N)

## Other changes

- <a change a consumer notices that fits no section above>. (#N)

## Commits

- <short sha> <subject>

Full changelog: https://github.com/atomicassets/atomicassets-api/compare/<PREV>...<TAG>
```

The section order is breaking changes, upgrading, features, bug fixes,
security, deprecations, other changes.

`## Upgrading` is for the operator who runs this service: the migrations that
apply at boot and how long they take, the configuration keys that are new or
renamed and their defaults, the image tags to move, and any repair step. It is
written against the previous stable release of the line, not against the tag
range the commit list covers. A prerelease body may confine it to the change
since the previous prerelease that has a Release, because that is the move a
test deployment makes; the stable body describes the whole move. One table is
allowed here when it lists migrations or configuration keys. Items elsewhere
stay bullets.

`## Security` carries advisories and dependency lifts, each naming its GHSA or
CVE identifier. A release with neither section leaves both out.

## Voice

- Neutral and factual, the register of the Node.js or esbuild release notes.
- Sectioned. The heading says what kind of change it is, so the item does not
  repeat it.
- One to three plain sentences per item: what changed, and what the reader does
  about it when action is needed. Code identifiers in backticks.
- Every item ends with its PR reference `(#N)`, or with its short sha in
  backticks when the change had no PR. An `## Upgrading` item that states an
  operator fact rather than a change, such as the image tag or a migration set
  that has not moved, carries no reference.
- No preface, no motivation essay, no clause chain explaining how the author got
  there. The why stays only where it changes what the reader does.
- Present tense for the new behavior, sentence-case headings, straight quotes,
  and no em-dash.

## The CHANGELOG entry

`CHANGELOG.md` is where the editorial text is written, and the Release body is
that entry with its headings promoted one level. Two copies of the file exist,
one per line: `main` carries the 2.x line and `release/1.7` carries the
maintenance line. The entry lives on the branch that gets tagged.

An entry heading is `## [X.Y.Z]`, optionally followed by ` - YYYY-MM-DD`. Under
it comes an optional one-line summary, then the H3 sections in the order above
(`### Breaking changes`, `### Upgrading`, and the rest). A prerelease tag
`X.Y.Z-rcN` reads the `## [X.Y.Z]` entry as it stands at that tag, so an rc body
shows the notes for the line so far and the stable body shows the finished
entry.

## Tag ranges, prereleases, and older releases

- `PREV` for a stable tag is the nearest earlier stable tag in the same
  namespace, so a stable release lists every commit since the last stable
  release and skips the prereleases between them. `PREV` for a prerelease tag is
  the nearest earlier tag of any kind, which is usually the previous prerelease.
  A stable tag whose only earlier tags are prereleases takes the nearest of
  them, so the first stable release after a candidate line lists what it adds
  to the last candidate.
- The namespace comes from the tag shape: bare `MAJOR.MINOR.PATCH` for the 2.x
  line on `main`, `v1.7.x` for the maintenance line on `release/1.7`. A tag in
  one namespace never resolves `PREV` in the other.
- `## Commits` lists the whole `PREV..TAG` range, oldest first, including the
  release commit. Its line count equals `git rev-list --count PREV..TAG`.
- A tag with no earlier tag in its namespace has no `PREV`. Its body is the
  summary and the sentence `Initial release.`, with no commit list and no
  compare link, and it is written by hand.
- A prerelease tag is created with `--prerelease`, and a Release created for a
  tag older than the current latest is created with `--latest=false`.

`scripts/release-notes.sh` needs bash, git, awk and sed. Without a ref it reads
the `CHANGELOG.md` at the tag rather than from the working tree, so the body
describes what the tag ships. It exits non-zero and names what is missing when
no tag is given, when the tag does not exist, when the CHANGELOG at that ref
carries no entry for the version, and when no earlier tag exists in the
namespace.
