<#
.SYNOPSIS
    Verifica que el entorno este listo para ejecutar la wiki.

.DESCRIPTION
    Comprueba:
    - instalacion de .NET 8 o superior
    - estructura basica del proyecto
    - carpeta Data y base de datos
    - restauracion de dependencias
    - compilacion del proyecto
    - disponibilidad de puertos comunes

.EXAMPLE
    .\scripts\verify-environment.ps1
#>

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   Wiki - Verificacion de entorno" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$allOk = $true
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir '..')
$projectFile = Get-ChildItem -Path $projectRoot -Filter *.csproj -File | Select-Object -First 1

Write-Host "[1/6] Verificando .NET SDK..." -ForegroundColor Yellow
try {
    $dotnetVersion = & dotnet --version 2>$null
    if ($dotnetVersion -match "^([8-9]|1[0-9])\.") {
        Write-Host "  OK .NET SDK instalado: $dotnetVersion" -ForegroundColor Green
    } else {
        Write-Host "  ERROR .NET SDK demasiado antiguo: $dotnetVersion" -ForegroundColor Red
        $allOk = $false
    }
} catch {
    Write-Host "  ERROR .NET SDK no encontrado" -ForegroundColor Red
    $allOk = $false
}
Write-Host ""

Write-Host "[2/6] Verificando estructura del proyecto..." -ForegroundColor Yellow
$requiredFiles = @(
    "Program.cs",
    "appsettings.json",
    "static-wiki\index.html",
    "static-wiki\app-api.js"
)
foreach ($file in $requiredFiles) {
    $fullPath = Join-Path $projectRoot $file
    if (Test-Path $fullPath) {
        Write-Host "  OK $file" -ForegroundColor Green
    } else {
        Write-Host "  ERROR falta $file" -ForegroundColor Red
        $allOk = $false
    }
}
if ($projectFile) {
    Write-Host "  OK $($projectFile.Name)" -ForegroundColor Green
} else {
    Write-Host "  ERROR falta un archivo .csproj en la raiz del proyecto" -ForegroundColor Red
    $allOk = $false
}
Write-Host ""

Write-Host "[3/6] Verificando base de datos..." -ForegroundColor Yellow
$dataDir = Join-Path $projectRoot "Data"
$dbPath = Join-Path $dataDir "wiki.db"
if (Test-Path $dataDir) {
    Write-Host "  OK carpeta Data/ presente" -ForegroundColor Green
    if (Test-Path $dbPath) {
        $dbSize = [math]::Round((Get-Item $dbPath).Length / 1MB, 2)
        Write-Host "  OK base de datos presente (${dbSize} MB)" -ForegroundColor Green
    } else {
        Write-Host "  AVISO wiki.db no existe todavia; se creara al iniciar" -ForegroundColor Yellow
    }
} else {
    Write-Host "  AVISO carpeta Data/ no existe todavia; se creara al iniciar" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "[4/6] Verificando dependencias NuGet..." -ForegroundColor Yellow
Push-Location $projectRoot
try {
    $restoreOutput = & dotnet restore 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  OK dependencias restauradas" -ForegroundColor Green
    } else {
        Write-Host "  ERROR al restaurar dependencias" -ForegroundColor Red
        $allOk = $false
    }
} catch {
    Write-Host "  ERROR al verificar dependencias: $_" -ForegroundColor Red
    $allOk = $false
} finally {
    Pop-Location
}
Write-Host ""

Write-Host "[5/6] Compilando proyecto..." -ForegroundColor Yellow
Push-Location $projectRoot
try {
    $buildOutput = & dotnet build --no-restore 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  OK compilacion correcta" -ForegroundColor Green
    } else {
        Write-Host "  ERROR al compilar el proyecto" -ForegroundColor Red
        $allOk = $false
    }
} catch {
    Write-Host "  ERROR durante la compilacion: $_" -ForegroundColor Red
    $allOk = $false
} finally {
    Pop-Location
}
Write-Host ""

Write-Host "[6/6] Verificando puertos..." -ForegroundColor Yellow
$portsToCheck = @(5000, 5001, 8080)
$portsInUse = @()
foreach ($port in $portsToCheck) {
    $listener = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Host "  AVISO puerto $port en uso" -ForegroundColor Yellow
        $portsInUse += $port
    } else {
        Write-Host "  OK puerto $port disponible" -ForegroundColor Green
    }
}
Write-Host ""

Write-Host "===================================================" -ForegroundColor Cyan
if ($allOk) {
    Write-Host "ENTORNO LISTO" -ForegroundColor Green -BackgroundColor Black
    Write-Host ""
    Write-Host "Puedes iniciar la aplicacion con:" -ForegroundColor White
    Write-Host "  .\scripts\start-local.ps1" -ForegroundColor Cyan
    Write-Host "  dotnet run --urls `"http://localhost:5000`"" -ForegroundColor Cyan
    if ($portsInUse.Count -gt 0) {
        Write-Host ""
        Write-Host "Si el puerto 5000 esta ocupado, prueba otro puerto." -ForegroundColor Yellow
    }
    exit 0
}

Write-Host "PROBLEMAS DETECTADOS" -ForegroundColor Red -BackgroundColor Black
Write-Host ""
Write-Host "Corrige lo indicado y vuelve a ejecutar:" -ForegroundColor Yellow
Write-Host "  .\scripts\verify-environment.ps1" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
exit 1
