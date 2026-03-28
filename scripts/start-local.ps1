<#
Start the local wiki application in development mode and save its PID.
Usage:
  .\scripts\start-local.ps1
  .\scripts\start-local.ps1 -Port 5001
#>
param(
  [int]$Port = 5000
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir '..')
$pidFile = Join-Path $scriptDir 'wiki.pid'

if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($existingPid) {
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "La aplicacion ya esta en ejecucion (PID=$existingPid)" -ForegroundColor Yellow
      Write-Host "Usa .\scripts\stop-local.ps1 antes de iniciar otra instancia." -ForegroundColor Yellow
      exit 1
    }
  }
}

Write-Host "Iniciando wiki local en http://localhost:$Port ..." -ForegroundColor Cyan

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'dotnet'
$psi.Arguments = "run --urls http://localhost:$Port"
$psi.WorkingDirectory = $projectRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

try {
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $started = $proc.Start()

  if ($started) {
    Set-Content -Path $pidFile -Value $proc.Id
    Write-Host "Aplicacion iniciada correctamente" -ForegroundColor Green
    Write-Host "  PID: $($proc.Id)" -ForegroundColor Gray
    Write-Host "  URL: http://localhost:$Port/wiki/" -ForegroundColor Gray
    Write-Host "  PID file: $pidFile" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Usa .\scripts\stop-local.ps1 para detenerla." -ForegroundColor Yellow
  } else {
    Write-Host "No se pudo iniciar la aplicacion" -ForegroundColor Red
    exit 1
  }
} catch {
  Write-Host "Error al iniciar la aplicacion: $_" -ForegroundColor Red
  exit 1
}
