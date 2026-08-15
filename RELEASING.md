# Releasing

Releases are built and published automatically by GitHub Actions when a version
tag is pushed. Versions follow [SemVer](https://semver.org/) with a `v` prefix.

## Steps

1. Make sure `main` is green (the CI workflow passed).
2. Update `CHANGELOG.md`: move entries from **Unreleased** into a new
   `## [X.Y.Z] - YYYY-MM-DD` section and update the link references at the
   bottom.
3. Commit and push:

   ```
   git commit -am "Release vX.Y.Z"
   git push
   ```

4. Tag and push the tag — this triggers the release workflow:

   ```
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The workflow builds the client bundle and the Windows binary with the version
stamped in (`-X main.version=vX.Y.Z`), packages
`pipatab-vX.Y.Z-windows-amd64.zip`, and creates a GitHub Release with
auto-generated notes. Edit the release afterwards to paste the changelog
section if desired.

## Version bumping

- The version string lives **only in the git tag** — there is nothing to bump
  in the source. `main.go` defaults to `dev` and gets the real version injected
  at build time.
- Local builds via `build.bat` stamp `git describe` output (e.g.
  `v2.0.0-3-gabc123-dirty`), so a dev build is always distinguishable from a
  release.
- The server prints its version on startup and with `pipatab.exe -version`;
  the iPad client shows it in the settings panel footer.
