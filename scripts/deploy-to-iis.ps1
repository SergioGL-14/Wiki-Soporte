# Script para desplegar la wiki en IIS
# Uso:
#   .\scripts\deploy-to-iis.ps1 -ServerIP "192.168.1.100" -Type full
#   .\scripts\deploy-to-iis.ps1 -ServerIP "192.168.1.100" -Type frontend -Port 8080

param(
    [Parameter(Mandatory = $true)]
    [string]$ServerIP,

    [Parameter(Mandatory = $false)]
    [ValidateSet("full", "frontend")]
    [string]$Type = "full",

    [Parameter(Mandatory = $false)]
    [string]$ServerPath = "C$\inetpub\wwwroot\Wiki",

    [Parameter(Mandatory = $false)]
    [string]$PublishPath = "C:\Publish\Wiki",

    [Parameter(Mandatory = $false)]
    [string]$SiteName = "Wiki",

    [Parameter(Mandatory = $false)]
    [string]$AppPoolName = "WikiAppPool",

    [Parameter(Mandatory = $false)]
    [string]$Scheme = "http",

    [Parameter(Mandatory = $false)]
    [int]$Port = 80,

    [Parameter(Mandatory = $false)]
    [switch]$SkipBackup
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
$remotePath = "\\$ServerIP\$ServerPath"
$baseUrl = Get-BaseUrl -HostName $ServerIP -UrlScheme $Scheme -UrlPort $Port

Write-ColorOutput Green "========================================="
Write-ColorOutput Green "  Wiki - Despliegue IIS"
Write-ColorOutput Green "========================================="
Write-Host ""

Write-Host "Verificando conectividad con servidor $ServerIP..." -ForegroundColor Cyan
if (-not (Test-Connection -ComputerName $ServerIP -Count 1 -Quiet)) {
    Write-ColorOutput Red "No se puede conectar al servidor $ServerIP"
    exit 1
}
Write-ColorOutput Green "Servidor accesible"

if (-not (Test-Path $remotePath)) {
    Write-ColorOutput Red "No se puede acceder a $remotePath"
    Write-Host "Verifica permisos administrativos y que la ruta exista." -ForegroundColor Yellow
    exit 1
}
Write-ColorOutput Green "Ruta remota accesible: $remotePath"
Write-Host ""

if ($Type -eq "frontend") {
    Write-ColorOutput Cyan "Modo: FRONTEND ONLY"
    Write-Host "Se actualizaran solo HTML, JS y CSS." -ForegroundColor Gray
    Write-Host ""

    $staticWikiSource = Join-Path $projectPath "static-wiki"
    $staticWikiDest = Join-Path $remotePath "static-wiki"

    if (-not (Test-Path $staticWikiSource)) {
        Write-ColorOutput Red "No se encuentra la carpeta static-wiki en $staticWikiSource"
        exit 1
    }

    Write-Host "Copiando frontend..." -ForegroundColor Cyan
    robocopy $staticWikiSource $staticWikiDest /MIR /NFL /NDL /NJH /NJS /nc /ns /np

    if ($LASTEXITCODE -le 7) {
        Write-ColorOutput Green "Frontend actualizado correctamente"
        Write-Host ""
        Write-Host "URL: $baseUrl/wiki/" -ForegroundColor Cyan
        Write-Host "No es necesario reiniciar IIS para este tipo de cambio." -ForegroundColor Gray
        exit 0
    }

    Write-ColorOutput Red "Error al copiar archivos (codigo: $LASTEXITCODE)"
    exit 1
}

Write-ColorOutput Cyan "Modo: FULL DEPLOYMENT"
Write-Host "Se recompilara y desplegara backend + frontend." -ForegroundColor Gray
Write-Host ""

if (-not $SkipBackup) {
    Write-Host "Creando backup de la base de datos..." -ForegroundColor Cyan
    $dbSource = Join-Path $remotePath "Data\wiki.db"
    $backupDir = Join-Path $remotePath "Data\Backups"

    if (-not (Test-Path $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }

    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupFile = Join-Path $backupDir "wiki_backup_$timestamp.db"

    if (Test-Path $dbSource) {
        Copy-Item $dbSource $backupFile -Force
        Write-ColorOutput Green "Backup guardado: $backupFile"
    } else {
        Write-ColorOutput Yellow "No se encontro base de datos previa (primera instalacion)."
    }

    Write-Host ""
} else {
    Write-ColorOutput Yellow "Backup omitido por parametro -SkipBackup"
}

Write-Host "Compilando y publicando la aplicacion..." -ForegroundColor Cyan
Set-Location $projectPath
$publishOutput = dotnet publish -c Release -o $PublishPath 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-ColorOutput Red "Error al publicar la aplicacion:"
    Write-Host $publishOutput
    exit 1
}
Write-ColorOutput Green "Aplicacion publicada en: $PublishPath"
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
    Read-Host "Pulsa Enter cuando hayas detenido el sitio"
}
Write-Host ""

Write-Host "Copiando archivos al servidor..." -ForegroundColor Cyan
Write-Host "Se preservan Data y logs." -ForegroundColor Gray
robocopy $PublishPath $remotePath /MIR /XD Data logs /NFL /NDL /NJH /NJS /nc /ns /np
if ($LASTEXITCODE -gt 7) {
    Write-ColorOutput Red "Error al copiar archivos (codigo: $LASTEXITCODE)"
    exit 1
}
Write-ColorOutput Green "Archivos copiados correctamente"
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
    Read-Host "Pulsa Enter cuando hayas iniciado el sitio"
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
Write-ColorOutput Green "Deployment completado"
Write-ColorOutput Green "========================================="
Write-Host "URL: $baseUrl/wiki/" -ForegroundColor Cyan
Write-Host "Actualizacion rapida de frontend:" -ForegroundColor Gray
Write-Host "  .\scripts\deploy-to-iis.ps1 -ServerIP '$ServerIP' -Type frontend -Port $Port -SiteName '$SiteName' -AppPoolName '$AppPoolName'" -ForegroundColor Gray
