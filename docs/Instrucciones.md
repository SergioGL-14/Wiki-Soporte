# Instrucciones de uso

Referencia funcional de la aplicacion.

## 1. Acceso

La wiki se abre desde:

- `http://localhost:5000/wiki/` en local
- `http://servidor/wiki/` o `http://servidor:puerto/wiki/` en IIS

La portada muestra:

- avisos recientes
- resumen de incidencias
- articulos recientes
- buscador global

Si la base de datos esta vacia, la portada seguira funcionando y mostrara estados vacios en lugar de contenido.

## 2. Navegacion general

### Panel izquierdo

El panel izquierdo muestra un arbol de categorias.

- `Inicio` vuelve a la portada.
- Al pulsar una categoria, la rama puede expandirse o contraerse.
- Al pulsar el nombre de una categoria, el contenido central muestra sus subcategorias y articulos asociados.
- Los cambios en articulos y categorias se refrescan en la interfaz sin necesidad de recargar la pagina.

### Menu superior

El menu superior contiene accesos a:

- Nueva pagina
- Avisos
- Diagramas
- Categorias
- Incidencias

## 3. Busqueda

El buscador global funciona desde la cabecera.

- lanza filtrado local inmediato
- consulta al backend para completar resultados
- descarta respuestas antiguas si llega una busqueda mas reciente
- mantiene la ruta exacta si estas en un articulo compartido

Uso recomendado:

- empieza por una palabra del titulo
- afina con terminos del contenido si necesitas mas precision

## 4. Articulos

### Ver articulo

Al abrir un articulo se muestran:

- titulo
- contenido
- metadatos basicos
- acciones de editar, eliminar y copiar enlace

El enlace directo usa la ruta hash del articulo:

```text
/wiki/#/articulo/mi-slug
```

### Crear articulo

Desde `Nueva pagina`:

1. Introduce el titulo.
2. Selecciona una o varias categorias.
3. Si no existe una categoria adecuada, puedes crearla desde el propio editor.
4. Escribe el contenido.
5. Guarda.

### Editar articulo

- El editor reutiliza la misma pantalla de creacion.
- Al editar una pagina existente, el guardado se resuelve por `id`.
- Tras guardar, el menu lateral y los listados recientes se actualizan sin recargar.

## 5. Categorias

La pantalla de categorias permite:

- crear
- renombrar
- cambiar la categoria padre
- borrar
- buscar por nombre

Ademas:

- las categorias tambien pueden crearse desde el editor de articulos
- el selector del editor muestra la jerarquia para facilitar la eleccion

## 6. Avisos

La pantalla de avisos permite:

- crear avisos
- listar avisos existentes
- editar
- borrar

Los avisos recientes tambien aparecen en la portada.

## 7. Incidencias

La pantalla de incidencias funciona como un tablero:

- crear columna
- crear tarjeta
- mover tarjeta entre columnas
- marcar como resuelta
- reabrir
- borrar tarjeta
- borrar columna

Al cerrar el modal de creacion o edicion, el scroll de la pagina se restaura automaticamente.

## 8. Diagramas

La pantalla de diagramas permite:

- subir un HTML
- asignar nombre visible y descripcion
- listar diagramas existentes
- abrirlos en ventana aparte
- borrar

Al subir un HTML, el backend intenta normalizar rutas relativas de imagenes para que funcionen dentro de la aplicacion.

## 9. Sincronizacion entre usuarios

La aplicacion no usa SignalR ni WebSockets.

Estado actual:

- hay comprobacion periodica cada 30 segundos
- la sincronizacion esta pensada para consulta y actualizaciones ligeras
- no es edicion colaborativa en tiempo real

## 10. Comportamientos importantes

- La aplicacion soporta enlaces profundos a articulos concretos.
- La base de datos puede arrancar vacia y poblarse desde la interfaz.
- El editor rico depende de Quill cargado desde CDN, pero existe un fallback basico.
- La wiki puede servirse desde IIS en una subruta y el frontend ya calcula la base de la aplicacion para sus llamadas.

## 11. Comprobaciones basicas si algo falla

- `GET /api/health` debe responder `healthy`.
- Si una vista no carga, revisa la consola del navegador.
- Si la edicion avanzada no aparece, comprueba la carga de Quill.
- Si acabas de desplegar cambios frontend y no se reflejan, fuerza recarga del navegador.
