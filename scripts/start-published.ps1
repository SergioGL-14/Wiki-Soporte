<#
Start a published build of the wiki from a publish folder.
Usage:
  .\scripts\start-published.ps1
  .\scripts\start-published.ps1 -PublishPath 'C:\inetpub\wwwroot\WikiApp' -Port 5000
#>
param(
  [Parameter(Mandatory = $false)] [string]$PublishPath = "",
  [int]$Port = 5000
)

function Get-PublishEntrypoint([string]$Path) {
  $runtimeConfig = Get-ChildItem -Path $Path -Filter *.runtimeconfig.json -File | Select-Object -First 1
  if ($runtimeConfig) {
    $candidate = Join-Path $Path ($runtimeConfig.BaseName + '.dll')
    if (Test-Path $candidate) { return $candidate }
  }

  $dll = Get-ChildItem -Path $Path -Filter *.dll -File |
    Where-Object { $_.Name -notlike 'System.*' -and $_.Name -notlike 'Microsoft.*' } |
    Select-Object -First 1

  if ($dll) { return $dll.FullName }
  return $null
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir '..')

if ([string]::IsNullOrWhiteSpace($PublishPath)) {
  $PublishPath = Join-Path $projectRoot 'publish'
}

if (-not (Test-Path $PublishPath)) {
  Write-Host "No existe la carpeta publish: $PublishPath" -ForegroundColor Red
  exit 1
}

$entryDll = Get-PublishEntrypoint -Path $PublishPath
if (-not $entryDll) {
  Write-Host "No se ha podido localizar la DLL principal dentro de $PublishPath" -ForegroundColor Red
  exit 1
}

. (Join-Path $scriptDir 'stop-local.ps1')

Push-Location -Path $PublishPath
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'dotnet'
  $psi.Arguments = ".\$(Split-Path $entryDll -Leaf) --urls http://localhost:$Port"
  $psi.WorkingDirectory = $PublishPath
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  if ($proc.Start()) {
    $pidFile = Join-Path $scriptDir 'wiki.pid'
    Set-Content -Path $pidFile -Value $proc.Id
    Write-Host "Version publicada iniciada (PID=$($proc.Id))" -ForegroundColor Green
    Write-Host "  URL: http://localhost:$Port/wiki/" -ForegroundColor Gray
    Write-Host "  DLL: $(Split-Path $entryDll -Leaf)" -ForegroundColor Gray
  } else {
    Write-Host "No se pudo iniciar la version publicada" -ForegroundColor Red
  }
} finally {
  Pop-Location
}
