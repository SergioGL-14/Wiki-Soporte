# Guia completa de instalacion y operacion en IIS

Runbook tecnico para instalar, actualizar, mantener y recuperar la aplicacion en IIS.

## 1. Escenario objetivo

Aplicacion desplegada en IIS con:

- SPA servida en `/wiki/`
- API en `/api/*`
- SQLite local en `Data/wiki.db`
- diagramas HTML en `wwwroot/diagramas`

## 2. Instalacion inicial

### Paso 1. Preparar el servidor

1. Instala IIS.
2. Instala ASP.NET Core Hosting Bundle para .NET 8.
3. Decide:
   - ruta fisica
   - puerto
   - nombre de sitio
   - nombre de App Pool
4. Crea carpeta destino, por ejemplo:

```text
C:\inetpub\wwwroot\Wiki
```

### Paso 2. Publicar desde desarrollo

```powershell
dotnet publish -c Release -o C:\Publish\Wiki
```

Notas:

- en una restauracion limpia necesitas acceso a NuGet
- `static-wiki`, `Data` y `wwwroot` entran en el publish

### Paso 3. Copiar al servidor

Por SMB:

```powershell
robocopy "C:\Publish\Wiki" "\\SERVER_IP\C$\inetpub\wwwroot\Wiki" /MIR
```

Si no usas SMB, copia por el medio habitual de tu infraestructura.

### Paso 4. Crear App Pool y Site

```powershell
Import-Module WebAdministration

New-WebAppPool -Name "WikiAppPool"
Set-ItemProperty "IIS:\AppPools\WikiAppPool" -Name managedRuntimeVersion -Value ""
Set-ItemProperty "IIS:\AppPools\WikiAppPool" -Name startMode -Value "AlwaysRunning"
Set-ItemProperty "IIS:\AppPools\WikiAppPool" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)

New-Website -Name "Wiki" `
  -PhysicalPath "C:\inetpub\wwwroot\Wiki" `
  -Port 8080 `
  -ApplicationPool "WikiAppPool"
```

### Paso 5. Permisos

```powershell
icacls "C:\inetpub\wwwroot\Wiki\Data" /grant "IIS AppPool\WikiAppPool:(OI)(CI)M" /T
icacls "C:\inetpub\wwwroot\Wiki\logs" /grant "IIS AppPool\WikiAppPool:(OI)(CI)M" /T
```

### Paso 6. Firewall

```powershell
New-NetFirewallRule -DisplayName "Wiki HTTP 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

### Paso 7. Validacion inicial

```powershell
Invoke-RestMethod http://localhost:8080/api/health
```

Pruebas manuales recomendadas:

- `http://localhost:8080/wiki/`
- buscador
- categorias
- avisos
- incidencias
- diagramas

## 3. Actualizacion solo frontend

Usa este modo cuando solo cambien:

- `static-wiki/index.html`
- `static-wiki/app-api.js`
- `static-wiki/styles.css`

Script recomendado:

```powershell
.\scripts\update-frontend-only.ps1 -ServerIP "SERVER_IP"
```

o

```powershell
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type frontend
```

Caracteristicas:

- no reinicia IIS
- no toca `Data`
- no toca `logs`

Riesgos:

- cache del navegador
- si hay cambios backend, este flujo no es suficiente

## 4. Actualizacion completa

Usa este modo cuando cambien:

- `Program.cs`
- `Services/*.cs`
- `Models/*.cs`
- middleware o configuracion del servidor

Script:

```powershell
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type full
```

El script:

1. comprueba conectividad al servidor
2. hace backup de `Data/wiki.db` si existe
3. ejecuta `dotnet publish`
4. intenta parar sitio y App Pool por `Invoke-Command`
5. copia el publish excluyendo `Data` y `logs`
6. intenta arrancar sitio y App Pool
7. valida `/api/health`

Importante:

- si no tienes WinRM operativo, el script cambiara a modo manual guiado
- si el build necesita restaurar paquetes y tu entorno no tiene salida a NuGet, la publicacion fallara

## 5. Sustitucion de base de datos

Usa este flujo solo si quieres reemplazar la base del servidor por otra base ya existente.

Script:

```powershell
.\scripts\copy-db-to-server.ps1 -ServerIP "SERVER_IP"
```

Flujo real:

1. pide confirmacion explicita
2. detiene sitio y App Pool
3. guarda backup en `Data\Backups`
4. copia `Data\wiki.db`
5. reinicia IIS
6. comprueba salud

Precauciones:

- este flujo pisa datos del servidor
- revisa `Scheme` y `Port` para la validacion final si no usas los valores por defecto

## 6. Backups y rollback

### Backup manual rapido

```powershell
Copy-Item "C:\inetpub\wwwroot\Wiki\Data\wiki.db" "C:\Backups\wiki_$(Get-Date -Format yyyyMMdd_HHmmss).db"
```

### Rollback de aplicacion

Estrategia recomendada:

1. conservar un publish anterior estable
2. detener IIS
3. restaurar carpeta de aplicacion
4. mantener `Data` y `logs` si no forman parte del rollback
5. arrancar IIS

### Rollback de base de datos

1. detener sitio
2. restaurar backup de `wiki.db`
3. arrancar sitio
4. validar `/api/health` y una ruta funcional

## 7. Operacion diaria

### Comprobaciones minimas

- `/api/health`
- acceso a `/wiki/`
- apertura de articulo compartido
- buscador
- categorias
- avisos
- incidencias

### Mantenimiento basico

- limpiar logs antiguos si activaste `stdoutLogEnabled`
- revisar espacio en `Data`
- revisar backups en `Data\Backups`
- revisar permisos de App Pool tras cambios de seguridad

## 8. Troubleshooting

### La SPA no carga

Comprobar:

- que `static-wiki/` existe en el despliegue
- que `/wiki/` responde
- que `index.html`, `app-api.js` y `styles.css` se sirven

### El editor enriquecido no aparece

Posible causa:

- el navegador no puede cargar Quill desde CDN

Accion:

- validar conectividad saliente o cache previa
- el sistema puede seguir funcionando con el fallback basico

### El script no puede parar IIS

Posible causa:

- `Invoke-Command` sin WinRM operativo

Accion:

- parar sitio y App Pool manualmente
- continuar el script cuando lo pida

### La base de datos se bloquea

Comprobar:

- permisos en `Data`
- que la aplicacion esta usando el mismo fichero
- estado general del sitio

### El buscador falla con determinados terminos

La busqueda usa FTS cuando esta disponible y tiene fallback a busqueda simple. Si ves un comportamiento extrano con caracteres especiales, revisa `PageService.Search`.

## 9. Puntos a revisar tras cambios grandes

- categorias
- slugs de articulos
- busqueda
- carga bajo `/wiki/`
- diagramas con recursos relativos
- avisos e incidencias en portada
