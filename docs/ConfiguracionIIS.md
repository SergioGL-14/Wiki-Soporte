# Configuracion recomendada en IIS

Configuracion de referencia para desplegar la wiki en IIS.

## 1. Requisitos

### En el servidor

- IIS instalado
- ASP.NET Core Hosting Bundle para .NET 8
- permisos sobre la carpeta de despliegue
- acceso a `C$` si vas a usar scripts remotos
- WinRM opcional si quieres parada y arranque remoto

### En la maquina de desarrollo

- SDK .NET 8 o superior
- acceso a la red del servidor
- PowerShell 5.1 o superior

## 2. Estructura recomendada en servidor

```text
C:\inetpub\wwwroot\Wiki
|-- <aplicacion>.dll
|-- appsettings.json
|-- Data\
|   `-- wiki.db
|-- logs\
|-- static-wiki\
`-- wwwroot\
    |-- diagramas\
    `-- img\
```

Notas:

- `Data/wiki.db` se crea al iniciar si no existe.
- `wwwroot/diagramas` puede estar vacio al principio.

## 3. Application Pool

Configuracion recomendada:

- Name: `WikiAppPool`
- .NET CLR: `No Managed Code`
- Pipeline: `Integrated`
- Start mode: `AlwaysRunning`
- Idle timeout: `0`
- Identity: `ApplicationPoolIdentity` o cuenta de servicio

## 4. Sitio web

Configuracion de ejemplo:

- Site name: `Wiki`
- Physical path: `C:\inetpub\wwwroot\Wiki`
- Binding: `http`
- Puerto: el que decida vuestra operativa, por ejemplo `8080`

La aplicacion redirige:

- `/` -> `/wiki/`
- `/wiki` -> `/wiki/`

## 5. Permisos

Permisos minimos recomendados para la App Pool:

```powershell
icacls "C:\inetpub\wwwroot\Wiki\Data" /grant "IIS AppPool\WikiAppPool:(OI)(CI)M" /T
icacls "C:\inetpub\wwwroot\Wiki\logs" /grant "IIS AppPool\WikiAppPool:(OI)(CI)M" /T
```

Sin permisos de escritura en `Data`, la aplicacion no podra crear ni modificar la base de datos.

## 6. Caching y archivos estaticos

Comportamiento actual del backend:

- HTML de la SPA: `no-cache, must-revalidate`
- JS y CSS: `public, max-age=600, must-revalidate`
- raiz del sitio: redirige a `/wiki/`

No hace falta duplicar esta logica en IIS salvo necesidades especiales.

## 7. Logs

Si necesitas diagnostico:

- habilita temporalmente `stdoutLogEnabled` en `web.config`
- crea la carpeta `logs`
- desactivalo despues de revisar

Ademas, revisa:

- Event Viewer
- logs de IIS si procede
- `/api/health`

## 8. Scripts de despliegue

### Solo frontend

```powershell
.\scripts\update-frontend-only.ps1 -ServerIP "SERVER_IP"
```

o

```powershell
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type frontend
```

### Despliegue completo

```powershell
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type full
```

### Copia de base de datos

```powershell
.\scripts\copy-db-to-server.ps1 -ServerIP "SERVER_IP"
```

Todos aceptan parametros para personalizar:

- `ServerPath`
- `SiteName`
- `AppPoolName`
- `Scheme`
- `Port`

## 9. Validacion minima despues del despliegue

```powershell
Invoke-RestMethod http://servidor:puerto/api/health
```

Despues prueba manualmente:

- `/wiki/`
- buscador
- apertura de un articulo compartido
- categorias
- avisos
- incidencias
- diagramas

## 10. Riesgos y notas operativas

- El editor enriquecido depende de Quill cargado desde CDN.
- La sincronizacion entre usuarios es ligera, no tiempo real.
- `static-wiki/app-api.js` sigue siendo un fichero grande y conviene mantenerlo bajo control en cambios grandes.
- Los diagramas HTML deben considerarse contenido de confianza.
