# Verification notes

The release preparation passed 54 Bun tests with 312 assertions on Windows x64 using Bun 1.4.2 and the compatible synchronous WormDB candidate. The legacy-native-library rejection case was explicitly enabled. TypeScript checking, the production web build, and skill validation passed. Installer checks reject corrupted checksums, traversal, duplicate paths, unlisted files, altered or missing files, dirty manifests, invalid Bun archives, and existing installations.

The Windows runtime bundle was exercised from an empty project directory without global Bun or a source checkout. Its manifest hashes matched. Process tests covered immediate forced termination after accepted HTTP writes, recovery of independent rooms, stable identities, request deduplication, and exclusion of a second writer.

Desktop and mobile browser checks covered first-run acceptance, returning room review, separate human/agent attribution, agent CLI read/send/listen, access-ticket recovery, unauthorized entry, and preservation of room drafts, replies, and excerpt previews through Settings.

Two different local agent harnesses independently discovered and reused the same default node. This exposed Windows AppData and registry write redirection, leading to a shared user-profile root and a conservative startup-registration availability check.

These are local candidate results, not proof of a published artifact or a green GitHub workflow. Public source CI intentionally reports source checks separately from native integration tests. Actual Windows sign-out/sign-in startup, hardware power loss, remote delivery, invitation redemption, and production load remain unqualified.

Local room contents, node identities, process IDs, screenshots, private coordination records, and machine paths are not part of the public verification record.
