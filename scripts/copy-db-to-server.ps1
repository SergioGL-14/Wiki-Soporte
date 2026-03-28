# Script para copiar la base de datos local al servidor IIS
# Uso:
#   .\scripts\copy-db-to-server.ps1 -ServerIP "10.11.72.80"
#   .\scripts\copy-db-to-server.ps1 -ServerIP "10.11.72.80" -Port 8080 -SiteName "Wiki"

param(
    [Parameter(Mandatory = $true)]
    [string]$ServerIP,

    [Parameter(Mandatory = $false)]
    [string]$ServerPath = "C$\inetpub\wwwroot\Wiki",

    [Parameter(Mandatory = $false)]
    [string]$SiteName = "Wiki",

    [Parameter(Mandatory = $false)]
    [string]$AppPoolName = "WikiAppPool",

    [Parameter(Mandatory = $false)]
    [string]$Scheme = "http",

    [Parameter(Mandatory = $false)]
    [int]$Port = 80
)

$ErrorActionPreference = "Stop"

function Write-ColorOutput($ForegroundColor, [string]$Message) {
    $currentColor = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    Write-Output $Message
    $host.UI.RawUI.ForegroundColor = $currentColor
}

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
$localDbPath = Join-Path $projectPath "Data\wiki.db"
$remotePath = "\\$ServerIP\$ServerPath"
$remoteDbPath = Join-Path $remotePath "Data\wiki.db"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$baseUrl = Get-BaseUrl -HostName $ServerIP -UrlScheme $Scheme -UrlPort $Port

Write-ColorOutput Green "========================================="
Write-ColorOutput Green "  Wiki - Actualizacion BD"
Write-ColorOutput Green "========================================="
Write-Host ""

if (-not (Test-Path $localDbPath)) {
    Write-ColorOutput Red "No se encuentra la base de datos local: $localDbPath"
    exit 1
}

$localSize = [math]::Round((Get-Item $localDbPath).Length / 1MB, 2)
Write-ColorOutput Green "Base de datos local encontrada"
Write-Host "Tamano: $localSize MB" -ForegroundColor Gray
Write-Host ""

Write-Host "Verificando conectividad con $ServerIP..." -ForegroundColor Cyan
if (-not (Test-Connection -ComputerName $ServerIP -Count 1 -Quiet)) {
    Write-ColorOutput Red "No se puede conectar al servidor $ServerIP"
    exit 1
}
Write-ColorOutput Green "Servidor accesible"

if (-not (Test-Path $remotePath)) {
    Write-ColorOutput Red "No se puede acceder a $remotePath"
    Write-Host "Verifica permisos administrativos." -ForegroundColor Yellow
    exit 1
}
Write-ColorOutput Green "Ruta remota accesible"
Write-Host ""

Write-Host "ADVERTENCIA: se reemplazara la base de datos del servidor." -ForegroundColor Yellow
Write-Host "Servidor: $ServerIP" -ForegroundColor Gray
Write-Host "Ruta remota: $remoteDbPath" -ForegroundColor Gray
Write-Host ""
$confirm = Read-Host "Deseas continuar? (S/N)"
if ($confirm -notin @("S", "s")) {
    Write-Host "Operacion cancelada por el usuario." -ForegroundColor Yellow
    exit 0
}
Write-Host ""

Write-Host "Deteniendo sitio IIS..." -ForegroundColor Cyan
try {
    Invoke-Command -ComputerName $ServerIP -ScriptBlock {
        param($RemoteSiteName, $RemoteAppPoolName)
        Stop-Website -Name $RemoteSiteName -ErrorAction SilentlyContinue
        Stop-WebAppPool -Name $RemoteAppPoolName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } -ArgumentList $SiteName, $AppPoolName -ErrorAction Stop
    Write-ColorOutput Green "Sitio detenido"
} catch {
    Write-ColorOutput Yellow "No se pudo detener IIS remotamente."
    Write-Host "Hazlo manualmente si es necesario:" -ForegroundColor Yellow
    Write-Host "  Stop-Website -Name '$SiteName'" -ForegroundColor Gray
    Write-Host "  Stop-WebAppPool -Name '$AppPoolName'" -ForegroundColor Gray
    Write-Host ""
    Read-Host "Pulsa Enter cuando el sitio este detenido"
}
Write-Host ""

Write-Host "Generando backup de la base de datos remota..." -ForegroundColor Cyan
$backupDir = Join-Path $remotePath "Data\Backups"
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

$backupFile = Join-Path $backupDir "wiki_backup_$timestamp.db"
if (Test-Path $remoteDbPath) {
    try {
        Copy-Item $remoteDbPath $backupFile -Force
        $backupSize = [math]::Round((Get-Item $backupFile).Length / 1MB, 2)
        Write-ColorOutput Green "Backup guardado: $backupFile"
        Write-Host "Tamano backup: $backupSize MB" -ForegroundColor Gray
    } catch {
        Write-ColorOutput Yellow "No se pudo crear el backup remoto."
    }
} else {
    Write-ColorOutput Yellow "No existia una base de datos previa en el servidor."
}
Write-Host ""

Write-Host "Copiando base de datos al servidor..." -ForegroundColor Cyan
try {
    Copy-Item $localDbPath $remoteDbPath -Force
    $remoteSize = [math]::Round((Get-Item $remoteDbPath).Length / 1MB, 2)
    Write-ColorOutput Green "Base de datos copiada correctamente"
    Write-Host "Tamano remoto: $remoteSize MB" -ForegroundColor Gray
    if ($remoteSize -ne $localSize) {
        Write-ColorOutput Yellow "El tamano no coincide exactamente; revisalo si no esperabas cambios."
    }
} catch {
    Write-ColorOutput Red "Error al copiar la base de datos: $_"
    exit 1
}
Write-Host ""

Write-Host "Iniciando sitio IIS..." -ForegroundColor Cyan
try {
    Invoke-Command -ComputerName $ServerIP -ScriptBlock {
        param($RemoteSiteName, $RemoteAppPoolName)
        Start-WebAppPool -Name $RemoteAppPoolName -ErrorAction Stop
        Start-Sleep -Seconds 2
        Start-Website -Name $RemoteSiteName -ErrorAction Stop
        Start-Sleep -Seconds 3
    } -ArgumentList $SiteName, $AppPoolName -ErrorAction Stop
    Write-ColorOutput Green "Sitio iniciado"
} catch {
    Write-ColorOutput Yellow "No se pudo iniciar IIS remotamente."
    Write-Host "Hazlo manualmente si es necesario:" -ForegroundColor Yellow
    Write-Host "  Start-WebAppPool -Name '$AppPoolName'" -ForegroundColor Gray
    Write-Host "  Start-Website -Name '$SiteName'" -ForegroundColor Gray
    Write-Host ""
    Read-Host "Pulsa Enter cuando el sitio este iniciado"
}
Write-Host ""

Write-Host "Verificando funcionamiento..." -ForegroundColor Cyan
Start-Sleep -Seconds 3
try {
    $healthUrl = "$baseUrl/api/health"
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
    Write-ColorOutput Green "Aplicacion respondiendo correctamente"
    Write-Host "Status: $($response.status)" -ForegroundColor Gray
    Write-Host "Timestamp: $($response.timestamp)" -ForegroundColor Gray
} catch {
    Write-ColorOutput Yellow "No se pudo verificar el health check."
    Write-Host "Verifica manualmente: $baseUrl/api/health" -ForegroundColor Gray
}

Write-Host ""
Write-ColorOutput Green "========================================="
Write-ColorOutput Green "Base de datos actualizada"
Write-ColorOutput Green "========================================="
Write-Host "URL: $baseUrl/wiki/" -ForegroundColor Cyan
Write-Host "Backup remoto: $backupFile" -ForegroundColor Gray
