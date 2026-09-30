[CmdletBinding()]
param([string]$SourceDir, [string]$OutDir, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = Split-Path $PSScriptRoot -Parent
$lock = Get-Content -LiteralPath (Join-Path $repository 'native/wormdb.lock.json') -Raw | ConvertFrom-Json
if (-not $OutDir) { $OutDir = Join-Path $repository '.local/native' }
$output = [IO.Path]::GetFullPath($OutDir)
$dll = Join-Path $output $lock.artifact.name
function Verify-Library([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Native library is missing.' }
    if ((Get-Item -LiteralPath $Path).Length -ne $lock.artifact.size -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.artifact.sha256) { throw 'Native library differs from the reviewed lockfile.' }
}
if ($VerifyOnly) { Verify-Library $dll; Write-Output 'Native library matches the reviewed lockfile.'; return }
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Build on Windows x64.' }
if (-not $SourceDir) { $SourceDir = $env:WORMDB_SRC }
if (-not $SourceDir) { throw 'Pass -SourceDir with a clean WormDB checkout at the locked candidate commit.' }
$source = (Resolve-Path -LiteralPath $SourceDir).Path
function Verify-Source([string]$Path, [string]$Commit) {
    $head = git -C $Path rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $head -cne $Commit) { throw 'Native source commit differs from lockfile.' }
    $status = git -C $Path status --porcelain
    if ($LASTEXITCODE -ne 0 -or $status) { throw 'Native source must be clean, including submodules.' }
}
Verify-Source $source $lock.candidateCommit
$meshguard = Join-Path $source 'deps/meshguard'
Verify-Source $meshguard $lock.meshguardCommit
$zigVersion = zig version
if ($LASTEXITCODE -ne 0 -or $zigVersion -cne $lock.toolchain.version) { throw 'Zig version differs from lockfile.' }
if (Test-Path -LiteralPath $dll) { throw 'Output DLL already exists. Use a fresh -OutDir or -VerifyOnly.' }
$scratch = Join-Path $repository ('.local/native-build/' + [guid]::NewGuid().ToString('N'))
$buildSource = Join-Path $scratch 'source'
[IO.Directory]::CreateDirectory($buildSource) | Out-Null
# Export only the pinned tracked input; never copy untracked private state.
$sourceArchive = Join-Path $scratch 'source.tar'
git -C $source archive --format=tar "--output=$sourceArchive" $lock.candidateCommit
if ($LASTEXITCODE -ne 0) { throw 'Could not export WormDB source.' }
tar -xf (Join-Path $scratch 'source.tar') -C $buildSource
if ($LASTEXITCODE -ne 0) { throw 'Could not extract WormDB source.' }
$buildMeshguard = Join-Path $buildSource 'deps/meshguard'
[IO.Directory]::CreateDirectory($buildMeshguard) | Out-Null
$meshguardArchive = Join-Path $scratch 'meshguard.tar'
git -C $meshguard archive --format=tar "--output=$meshguardArchive" $lock.meshguardCommit
if ($LASTEXITCODE -ne 0) { throw 'Could not export MeshGuard source.' }
tar -xf (Join-Path $scratch 'meshguard.tar') -C $buildMeshguard
if ($LASTEXITCODE -ne 0) { throw 'Could not extract MeshGuard source.' }
$prefix = Join-Path $scratch 'out'
Push-Location $buildSource
try {
    zig build ffi -Doptimize=ReleaseFast -j2 --prefix $prefix --cache-dir (Join-Path $scratch 'cache')
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
} finally { Pop-Location }
$built = Join-Path $prefix 'bin/wormdb_ffi.dll'
$builtHash = (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash.ToLowerInvariant()
$builtSize = (Get-Item -LiteralPath $built).Length
[IO.Directory]::CreateDirectory($output) | Out-Null
[IO.File]::Copy($built, $dll, $false)
$provenance = @{ schema = 1; sourceCommit = $lock.candidateCommit; meshguardCommit = $lock.meshguardCommit; zigVersion = $zigVersion; sha256 = $builtHash; size = $builtSize; builtAt = [DateTime]::UtcNow.ToString('o'); sourceMode = 'public tracked snapshot'; sourcePinsVerified = $true; matchesReviewedArtifact = ($builtHash -ceq $lock.artifact.sha256) }
[IO.File]::WriteAllText((Join-Path $output 'wormdb.provenance.json'), ($provenance | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Native candidate built from verified source pins: $dll ($builtHash). Run integration tests and review before updating the release artifact pin."
