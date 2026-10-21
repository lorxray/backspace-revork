# Release approval

The user requires this process for every new GitHub release of this application:

1. Build a local Windows portable executable with publishing disabled (`--publish never`). Run the relevant automated and packaging checks, then give the user the version, absolute local file link, changes, and SHA-256 of the candidate.
2. Wait for the user to test that portable and explicitly approve releasing that build. Passing automated tests or approval for an earlier version does not authorize a new release.
3. Only after approval, create the GitHub release and publish the tested portable and matching full application ZIP. Publish the same portable file the user tested.

Before approval, do not create a GitHub release (including drafts), upload release assets, push release tags, or trigger publishing workflows. In this repository, pushing a `v*` tag automatically creates a draft and uploads builds, and can also publish a Docker image.

If changes affect the tested application, build a new local portable and obtain another user test and release approval. Keep the tested artifact's revision and checksum so publication can be verified against it.
