# Script para actualizar solo el frontend (HTML, JS y CSS)
# Uso:
#   .\scripts\update-frontend-only.ps1 -ServerIP "192.168.1.100"
#   .\scripts\update-frontend-only.ps1 -ServerIP "192.168.1.100" -Port 8080

param(
    [Parameter(Mandatory = $true)]
    [string]$ServerIP,

    [Parameter(Mandatory = $false)]
    [string]$ServerPath = "C$\inetpub\wwwroot\Wiki",

    [Parameter(Mandatory = $false)]
    [string]$Scheme = "http",

    [Parameter(Mandatory = $false)]
    [int]$Port = 80
)

$ErrorActionPreference = "Stop"

function Get-BaseUrl([string]$HostName, [string]$UrlScheme, [int]$UrlPort) {
    $isDefaultPort =
        ($UrlScheme -eq "http" -and $UrlPort -eq 80) -or
        ($UrlScheme -eq "https" -and $UrlPort -eq 443)

    if ($isDefaultPort) {
        return "${UrlScheme}://${HostName}"
    }

    return "${UrlScheme}://${HostName}:$UrlPort"
}

$projectPath = Split-Path -Parent $PSScriptRoot
$staticWikiSource = Join-Path $projectPath "static-wiki"
$remotePath = "\\$ServerIP\$ServerPath\static-wiki"
$baseUrl = Get-BaseUrl -HostName $ServerIP -UrlScheme $Scheme -UrlPort $Port

Write-Host "=========================================" -ForegroundColor Green
Write-Host "  Wiki - Actualizacion frontend" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""

if (-not (Test-Path $staticWikiSource)) {
    Write-Host "No se encuentra la carpeta static-wiki" -ForegroundColor Red
    exit 1
}

Write-Host "Conectando a servidor..." -ForegroundColor Cyan
if (-not (Test-Path "\\$ServerIP\$ServerPath")) {
    Write-Host "No se puede acceder al servidor o a la ruta remota." -ForegroundColor Red
    exit 1
}
Write-Host "Servidor accesible" -ForegroundColor Green
Write-Host ""

Write-Host "Archivos a actualizar:" -ForegroundColor Cyan
Get-ChildItem $staticWikiSource | ForEach-Object {
    Write-Host "  - $($_.Name)" -ForegroundColor Gray
}
Write-Host ""

Write-Host "Copiando archivos..." -ForegroundColor Cyan
robocopy $staticWikiSource $remotePath /MIR /NFL /NDL /NJH /NJS /nc /ns /np

if ($LASTEXITCODE -le 7) {
    Write-Host ""
    Write-Host "Frontend actualizado correctamente" -ForegroundColor Green
    Write-Host "Los cambios deberian verse de inmediato." -ForegroundColor Gray
    Write-Host "URL: $baseUrl/wiki/" -ForegroundColor Cyan
    Write-Host "Si el navegador mantiene cache, prueba Ctrl+Shift+R." -ForegroundColor Gray
    exit 0
}

Write-Host "Error al copiar archivos (codigo: $LASTEXITCODE)" -ForegroundColor Red
exit 1
