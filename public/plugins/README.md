# Plugins de Tribuna

Capacidades opcionales que se cargan como archivos sueltos, sin bundler y sin
build. Un plugin es un `.js` en `public/plugins/` que se registra a sí mismo.

## Por qué existen así

`index.html` tiene un solo archivo de script de ~6.000 líneas. Meterle todo
encima lo hace inmanejable, pero **no se carga nada de terceros**: un script
externo corre con los mismos permisos que la página, y el token de redacción
vive en `sessionStorage` (`tribuna_writer_token`, index.html). Un tracker de
terceros podría leerlo y mandárselo a quien sea. Por eso los plugins se sirven
desde el propio dominio y la CSP sigue sin abrirse.

## Cómo se agrega uno

**1. Crear `public/plugins/mi-plugin.js`:**

```js
(function (registry) {
  'use strict';
  if (!registry) return;

  registry.register('mi-plugin', {
    // Se ejecuta una vez, cuando la app ya está lista. Si lanza, no tumba el
    // sitio: el registro lo aísla y lo reporta en consola.
    start(ctx) {
      ctx.noteUrl({ id: 'abc' });  // -> https://tribuna-heos.onrender.com/nota/abc
      ctx.siteUrl();               // -> https://tribuna-heos.onrender.com/
      ctx.escapeHtml('<b>');       // -> &lt;b&gt;
    },

    // Lo que el plugin expuse. index.html lo llama por su nombre.
    hazAlgo() {}
  });
})(window.TribunaPlugins);
```

**2. Sumar su etiqueta de carga en `index.html`, junto a las de sus pares:**

```html
<script src="/public/plugins/mi-plugin.js"></script>
```

**3. Llamarlo desde la app**, cerca de donde tenga sentido:

```js
const plugin = window.TribunaPlugins.get('mi-plugin');
if (plugin) plugin.hazAlgo();
```

Ese `if` no es opcional: si el archivo no cargó (404, caché viejo, CSP), la
página tiene que seguir funcionando igual.

## Lo que se le pasa al arrancar

`start(ctx)` recibe los helpers del núcleo, para que un plugin no reimplemente
lógica que ya existe y —esto es lo importante— no se invente su propia versión
de la URL de una nota:

| Helper | Para qué |
|---|---|
| `ctx.noteUrl(note)` | URL canónica de una nota: `/nota/<id>`. La misma que usan el `canonical`, el sitemap, el JSON-LD y el autopost a X. |
| `ctx.siteUrl()` | Raíz del sitio. |
| `ctx.escapeHtml(s)` | Escape de HTML, el mismo que usa el resto de la app. |

## Plugins que hay

| Nombre | Archivo | Qué hace |
|---|---|---|
| `share` | `public/plugins/share.js` | Botones de compartir: WhatsApp, X, Facebook, menú nativo del móvil y copiar enlace. |

## Notas sobre `share`

Los botones viven en el marcado de `index.html`, no en el plugin, a propósito:
así existen aunque el JS falle y no parpadean al cargar. El plugin solo maneja el
comportamiento.

El enlace que se comparte sale de `ctx.noteUrl(note)`, **nunca** de
`location.href`. Abrir una nota no cambia la ruta del navegador (la portada se
queda en `/`), así que con `location.href` se compartía el link de la portada:
quien lo recibía caía en el inicio y Google no recibía nada de la nota. Hay un
test que fija exactamente eso (`test/plugins.test.js`).

## Probar

```bash
node --test test/plugins.test.js
```

Los tests levantan el registro y el plugin en un `vm` con el DOM simulado, así que
miden el código real de `index.html` y de `public/plugins/`, no una copia.
