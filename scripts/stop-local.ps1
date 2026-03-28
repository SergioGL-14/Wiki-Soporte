<#
Stop the local wiki application started by start-local.ps1 or a matching dotnet instance.
Usage:
  .\scripts\stop-local.ps1
#>
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$pidFile = Join-Path $scriptDir 'wiki.pid'

Write-Host "Deteniendo wiki local..." -ForegroundColor Cyan

if (Test-Path $pidFile) {
  try {
    $pidContent = Get-Content $pidFile -ErrorAction Stop | Select-Object -First 1
    $processId = 0

    if ([int]::TryParse($pidContent, [ref]$processId)) {
      $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        Write-Host "Aplicacion detenida correctamente (PID: $processId)" -ForegroundColor Green
        exit 0
      }

      Write-Host "El PID guardado ya no esta activo. Limpiando fichero..." -ForegroundColor Yellow
      Remove-Item $pidFile -ErrorAction SilentlyContinue
    } else {
      Write-Host "PID invalido en wiki.pid. Limpiando..." -ForegroundColor Yellow
      Remove-Item $pidFile -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Host "Error leyendo wiki.pid: $($_.Exception.Message)" -ForegroundColor Red
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
}

Write-Host "Buscando procesos dotnet asociados al proyecto..." -ForegroundColor Gray

$procs = @()
try {
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq 'dotnet.exe' -and (
        ($_.CommandLine -like "*$projectRoot*") -or
        ($_.CommandLine -like '*dotnet run*')
      )
    }
} catch {
  $procs = Get-Process -Name dotnet -ErrorAction SilentlyContinue
}

if (-not $procs -or $procs.Count -eq 0) {
  Write-Host "No se ha encontrado ninguna instancia local asociada." -ForegroundColor Yellow
  exit 0
}

$stopped = 0
foreach ($p in $procs) {
  try {
    $procId = if ($p.ProcessId) { $p.ProcessId } else { $p.Id }
    Stop-Process -Id $procId -Force -ErrorAction Stop
    Write-Host "Proceso detenido (PID: $procId)" -ForegroundColor Green
    $stopped++
  } catch {
    Write-Host "No se pudo detener el proceso $procId : $_" -ForegroundColor Yellow
  }
}

if ($stopped -gt 0) {
  Write-Host "$stopped proceso(s) detenido(s)." -ForegroundColor Green
}
