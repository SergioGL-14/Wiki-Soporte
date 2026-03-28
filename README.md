# Wiki

Aplicacion web para documentacion interna, articulos, categorias jerarquicas, avisos, incidencias y diagramas HTML.

Si `Data/wiki.db` no existe, la aplicacion crea la estructura necesaria al iniciar.

## Resumen

- Backend en `ASP.NET Core 8` con minimal APIs.
- Frontend SPA servido desde `static-wiki/` en la ruta `/wiki/`.
- Persistencia en `SQLite` mediante `Data/wiki.db`.
- Busqueda de articulos con FTS cuando esta disponible.
- Editor rico con `Quill.js` y fallback basico si la libreria no carga.
- Despliegue pensado para IIS con scripts PowerShell.

## Funcionalidades

### Articulos

- Crear, editar y eliminar articulos.
- Slug generado a partir del titulo.
- Historial basico en `revisions`.
- Enlaces directos por hash: `#/articulo/{slug}`.
- Actualizacion inmediata del menu y de la portada tras guardar.

### Categorias

- Estructura padre/hijo.
- Arbol lateral contraible.
- Vista de contenido por categoria en el panel central.
- Creacion y gestion desde pantalla dedicada.
- Creacion rapida desde el editor de articulos.

### Avisos

- Lista de avisos recientes en la portada.
- Alta, edicion y borrado.

### Incidencias

- Tablero por columnas.
- Tarjetas con titulo y descripcion.
- Movimiento entre columnas.
- Resolucion y reapertura.

### Diagramas

- Subida de archivos `.html`.
- Metadatos por fichero.
- Vista previa y borrado.

## Arquitectura

### Frontend

- [index.html](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/static-wiki/index.html)
- [app-api.js](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/static-wiki/app-api.js)
- [styles.css](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/static-wiki/styles.css)

### Backend

- [Program.cs](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/Program.cs)
- [PageService.cs](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/Services/PageService.cs)
- [CategoriesService.cs](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/Services/CategoriesService.cs)
- [NoticesService.cs](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/Services/NoticesService.cs)
- [IncidentsService.cs](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/Services/IncidentsService.cs)

### Persistencia

Tablas principales:

- `pages`
- `revisions`
- `categories`
- `page_categories`
- `notices`
- `boards`
- `cards`

## Rutas principales

### Navegacion

- `/` redirige a `/wiki/`
- `/wiki/` sirve la SPA
- `#/` portada
- `#/articulo/{slug}` detalle de articulo
- `#/editar/{slug}` edicion
- `#/categorias`
- `#/avisos`
- `#/incidencias`
- `#/diagramas`

### API

- `GET /api/pages`
- `GET /api/pages/{slug}`
- `POST /api/pages`
- `DELETE /api/pages/{slug}`
- `GET /api/search?q={texto}`
- `GET /api/categories`
- `GET /api/categories/root`
- `GET /api/categories/{id}/children`
- `POST /api/categories`
- `PUT /api/categories/{id}`
- `DELETE /api/categories/{id}`
- `GET /api/notices`
- `POST /api/notices`
- `PUT /api/notices/{id}`
- `POST /api/notices/{id}`
- `DELETE /api/notices/{id}`
- `GET /api/incidents/boards`
- `POST /api/incidents/boards`
- `DELETE /api/incidents/boards/{id}`
- `GET /api/incidents/cards`
- `GET /api/incidents/cards/resolved`
- `POST /api/incidents/cards`
- `PUT /api/incidents/cards/{id}/move`
- `POST /api/incidents/cards/{id}/resolve`
- `POST /api/incidents/cards/{id}/unresolve`
- `DELETE /api/incidents/cards/{id}`
- `GET /api/diagramas`
- `POST /api/diagramas`
- `POST /api/diagramas/normalize-all`
- `DELETE /api/diagramas/{name}`
- `GET /api/health`

## Estructura del proyecto

```text
Wiki/
|-- Program.cs
|-- *.csproj
|-- appsettings.json
|-- Data/
|   `-- wiki.db
|-- Models/
|-- Services/
|-- static-wiki/
|   |-- index.html
|   |-- app-api.js
|   `-- styles.css
|-- wwwroot/
|   |-- css/
|   |-- diagramas/
|   `-- img/
|-- scripts/
`-- docs/
```

## Puesta en marcha local

### Requisitos

- SDK .NET 8 o superior
- PowerShell en Windows para usar los scripts
- Acceso a NuGet si necesitas una restauracion limpia

### Arranque rapido

```powershell
cd "C:\ruta\al\proyecto\Wiki"
.\scripts\start-local.ps1
```

Accesos habituales:

- `http://localhost:5000/wiki/`
- `http://localhost:5000/api/health`

### Comando directo

```powershell
dotnet run --urls "http://localhost:5000"
```

## Despliegue

Scripts principales:

- `scripts\update-frontend-only.ps1`
- `scripts\deploy-to-iis.ps1`
- `scripts\copy-db-to-server.ps1`

Documentacion operativa:

- [Instrucciones.md](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/docs/Instrucciones.md)
- [README-DEPLOYMENT.md](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/docs/README-DEPLOYMENT.md)
- [ConfiguracionIIS.md](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/docs/ConfiguracionIIS.md)
- [GUIA-COMPLETA-IIS.md](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/docs/GUIA-COMPLETA-IIS.md)
- [scripts/README.md](/C:/Users/Galvik/Documents/Proyectos/Wiki%20Soporte/scripts/README.md)

## Notas tecnicas

- La aplicacion mantiene sincronizacion ligera por polling, no colaboracion en tiempo real.
- El frontend principal sigue concentrado en un unico fichero grande: `static-wiki/app-api.js`.
- `Quill.js` se carga desde CDN. Si no esta disponible, el editor entra en modo basico.
- Los diagramas HTML deben tratarse como contenido de confianza.
- No hay una suite automatizada de tests en el repositorio.

## Contenido inicial

La aplicacion puede iniciarse sin contenido previo:

- sin articulos precargados
- sin categorias iniciales
- sin avisos
- sin incidencias
- sin diagramas de ejemplo

El contenido se genera desde la propia aplicacion o por migracion de datos.
