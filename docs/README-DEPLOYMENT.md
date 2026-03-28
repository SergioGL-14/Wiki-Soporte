# Deployment rapido

Guia de referencia para seleccionar el flujo de despliegue segun el tipo de cambio.

## 1. Matriz de decision

| Tipo de cambio | Script recomendado | Reinicio | Riesgo principal |
|---|---|---:|---|
| HTML, JS o CSS en `static-wiki/` | `scripts\\update-frontend-only.ps1` | No | cache del navegador |
| HTML, JS o CSS en `static-wiki/` | `scripts\\deploy-to-iis.ps1 -Type frontend` | No | permisos SMB |
| Backend C# o middleware | `scripts\\deploy-to-iis.ps1 -Type full` | Si | parada breve del sitio |
| Sustitucion de base de datos | `scripts\\copy-db-to-server.ps1` | Si | sobreescritura de datos |
| Primera instalacion | seguir `docs/ConfiguracionIIS.md` y `docs/GUIA-COMPLETA-IIS.md` | Si | permisos, Hosting Bundle, App Pool |

## 2. Scripts principales

### Solo frontend

```powershell
.\scripts\update-frontend-only.ps1 -ServerIP "SERVER_IP"
```

Alternativa:

```powershell
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type frontend
```

Uso correcto:

- cambios visuales
- cambios en la SPA
- cambios en menu, buscador, vistas o estilos

No usar para:

- cambios en `Program.cs`
- cambios en `Services/`
- cambios en `Models/`

### Despliegue completo

```powershell
.\scripts\deploy-to-iis.ps1 -ServerIP "SERVER_IP" -Type full
```

Uso correcto:

- cambios backend
- nuevos endpoints
- cambios de middleware
- cambios de esquema inicializable

Notas:

- hace `dotnet publish`
- copia al servidor excluyendo `Data` y `logs`
- intenta detener y arrancar IIS por `Invoke-Command`
- si no hay WinRM, cambia a modo manual guiado

### Copia de base de datos

```powershell
.\scripts\copy-db-to-server.ps1 -ServerIP "SERVER_IP"
```

Notas:

- hace backup previo en `Data\\Backups`
- sobreescribe `Data\\wiki.db` del servidor
- valida usando `Scheme` y `Port`, no un puerto fijo

## 3. Parametros utiles

Los scripts aceptan parametros para evitar dependencias con nombres fijos:

- `ServerPath`
- `SiteName`
- `AppPoolName`
- `Scheme`
- `Port`

Ejemplo:

```powershell
.\scripts\deploy-to-iis.ps1 `
  -ServerIP "SERVER_IP" `
  -Type full `
  -ServerPath "C$\inetpub\wwwroot\Wiki" `
  -SiteName "Wiki" `
  -AppPoolName "WikiAppPool" `
  -Port 8080
```

## 4. Checklist antes de actualizar

- validar el cambio en local
- confirmar acceso al servidor remoto por SMB
- confirmar permisos administrativos sobre `C$`
- confirmar si WinRM esta disponible
- avisar a usuarios si el cambio implica backend o base de datos

## 5. Checklist despues de actualizar

- abrir `/api/health`
- abrir `/wiki/`
- probar buscador
- abrir un articulo por enlace compartido
- probar categorias
- probar avisos
- probar incidencias
- probar diagramas si aplica

## 6. Cuando no usar los scripts sin revisar

No lances un despliegue directo sin revisar parametros si:

- el sitio usa otra ruta fisica
- el App Pool tiene otro nombre
- el puerto no es el esperado
- necesitas un rollback muy controlado

En esos casos, usa la guia completa y valida manualmente cada paso.
