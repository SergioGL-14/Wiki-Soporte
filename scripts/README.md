# Scripts PowerShell

Referencia de los scripts disponibles en el proyecto.

## 1. Scripts locales

### `verify-environment.ps1`

Verifica:

- SDK .NET instalado
- estructura basica del proyecto
- presencia de `Data/`
- `dotnet restore`
- `dotnet build`
- disponibilidad de puertos comunes

Notas:

- detecta automaticamente el archivo `.csproj`
- necesita acceso a NuGet si la restauracion no esta resuelta

### `start-local.ps1`

Inicia la aplicacion con `dotnet run` y guarda el PID en `scripts\wiki.pid`.

Uso:

```powershell
.\scripts\start-local.ps1
.\scripts\start-local.ps1 -Port 5001
```

### `stop-local.ps1`

Detiene la aplicacion:

- primero por `wiki.pid`
- despues por busqueda de procesos compatibles

### `restart-local.ps1`

Ejecuta `stop-local.ps1` y despues `start-local.ps1`.

### `start-published.ps1`

Ejecuta una version publicada desde una carpeta `publish`.

Uso:

```powershell
.\scripts\start-published.ps1
.\scripts\start-published.ps1 -PublishPath "C:\inetpub\wwwroot\Wiki" -Port 5000
```

Notas:

- por defecto busca `publish\` bajo la raiz del proyecto
- detecta automaticamente el `.dll` principal de la publicacion

## 2. Scripts de despliegue

### `update-frontend-only.ps1`

Copia solo `static-wiki\` al servidor remoto.

Uso:

```powershell
.\scripts\update-frontend-only.ps1 -ServerIP "SERVER_IP"
```

No reinicia IIS.

### `deploy-to-iis.ps1`

Script principal de despliegue.

Uso:

```powershell
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type frontend
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type full
```

Parametros habituales:

- `ServerIP`
- `Type` = `frontend` o `full`
- `ServerPath`
- `PublishPath`
- `SiteName`
- `AppPoolName`
- `Scheme`
- `Port`
- `SkipBackup`

Notas:

- usa `Invoke-Command` para parar y arrancar IIS en remoto
- si no hay WinRM, cambia a modo manual
- en modo `full` preserva `Data` y `logs`

### `copy-db-to-server.ps1`

Copia la base local al servidor tras hacer backup previo.

Uso:

```powershell
.\scripts\copy-db-to-server.ps1 -ServerIP "SERVER_IP"
```

Advertencias:

- sobrescribe la base del servidor
- la validacion final depende de `Scheme` y `Port`

## 3. Recomendacion practica

- cambio de frontend: `update-frontend-only.ps1`
- cambio de backend: `deploy-to-iis.ps1 -Type full`
- cambio de base de datos: `copy-db-to-server.ps1`

## 4. Orden recomendado

1. `verify-environment.ps1`
2. `start-local.ps1`
3. validar en navegador
4. si procede, ejecutar el despliegue

## 5. Observaciones

- Todos los scripts estan pensados para PowerShell en Windows.
- Ningun script depende ya de nombres fijos de sitio o App Pool si pasas los parametros adecuados.
- Revisa `ServerPath`, `SiteName`, `AppPoolName` y `Port` antes de ejecutar en produccion.
