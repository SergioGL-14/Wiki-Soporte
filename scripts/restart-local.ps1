<#
Restart the local wiki application.
Usage:
  .\scripts\restart-local.ps1
  .\scripts\restart-local.ps1 -Port 5000
#>
param(
  [int]$Port = 5000
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Reiniciando wiki local ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/2] Deteniendo..." -ForegroundColor Yellow
& (Join-Path $scriptDir 'stop-local.ps1')

Write-Host ""
Write-Host "Esperando 2 segundos..." -ForegroundColor Gray
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "[2/2] Iniciando..." -ForegroundColor Yellow
& (Join-Path $scriptDir 'start-local.ps1') -Port $Port

Write-Host ""
Write-Host "=== Reinicio completado ===" -ForegroundColor Cyan
