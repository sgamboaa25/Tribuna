// Plugin de compartir. Vive fuera de index.html a proposito: es la primera
// capacidad que se extrajo al sistema de plugins, y la que mas dependia de
// estar bien conectada con el resto.
//
// El detalle que importa: el enlace que se comparte es SIEMPRE la URL propia de
// la nota (/nota/<id>), nunca la que el visitante tiene en la barra de
// direcciones. Antes se usaba location.href, y como abrir una nota no cambia la
// ruta (la portada se queda en /), compartir desde la portada mandaba el link de
// la portada: el amigo caia en el inicio y Google no recibia nada de la nota.
//
// La URL sale de ctx.noteUrl(), que es la misma funcion que usan el canonical,
// el sitemap y el JSON-LD. Un solo lugar decide como se ve una nota en el mundo.

(function (registry) {
  'use strict';
  if (!registry) return;

  var SITE_NAME = 'Tribuna';
  var state = { title: SITE_NAME, url: '', note: null };

  function enc(value) {
    return encodeURIComponent(String(value == null ? '' : value));
  }

  // Todos los destinos usan el mismo par titulo/url. Agregar una red nueva es
  // agregar una entrada aca y el boton correspondiente en index.html.
  function destinations(title, url) {
    return {
      wa: 'https://wa.me/?text=' + enc(title + ' — ' + url),
      x: 'https://twitter.com/intent/tweet?text=' + enc(title) + '&url=' + enc(url),
      fb: 'https://www.facebook.com/sharer/sharer.php?u=' + enc(url)
    };
  }

  function setLink(selector, href) {
    var el = document.querySelector(selector);
    if (el) el.href = href;
  }

  function applyLinks() {
    var links = destinations(state.title, state.url);
    setLink('#shareWa', links.wa);
    setLink('#shareX', links.x);
    setLink('#shareFb', links.fb);
  }

  function setupCopy(ctx) {
    var btn = document.querySelector('#shareCopy');
    if (!btn || btn.dataset.shareCopyReady === '1') return;
    btn.dataset.shareCopyReady = '1';

    btn.addEventListener('click', function () {
      if (!navigator.clipboard) return;
      // Se copia la URL de la nota, no la de la barra de direcciones: si el
      // lector esta en la portada, esto es lo unico que sirve.
      navigator.clipboard
        .writeText(state.url)
        .then(function () {
          btn.classList.add('copied');
          btn.setAttribute('aria-label', 'Enlace copiado');
          setTimeout(function () {
            btn.classList.remove('copied');
            btn.setAttribute('aria-label', 'Copiar enlace');
          }, 2000);
        })
        .catch(function () {});
    });
  }

  function setupNative() {
    var btn = document.querySelector('#shareNative');
    if (!btn || !navigator.share) {
      // Sin Web Share API (escritorio, Firefox) el boton nativo no sirve de nada
      // y se esconde para no ofrecer un click muerto.
      if (btn) btn.style.display = 'none';
      return false;
    }
    if (btn.dataset.shareNativeReady === '1') return true;
    btn.dataset.shareNativeReady = '1';
    btn.addEventListener('click', function () {
      navigator.share({ title: state.title, url: state.url }).catch(function () {});
    });
    return true;
  }

  registry.register('share', {
    // Se ejecuta una vez, cuando la app ya tiene sus helpers disponibles.
    start: function (ctx) {
      state = { title: SITE_NAME, url: ctx.siteUrl(), note: null };
      var native = setupNative();
      setupCopy(ctx);

      // En movil se usa el menu nativo del sistema y los botones de cada red se
      // esconden: el menu ya ofrece WhatsApp y demas y duplicar seria ruido.
      if (native) {
        ['#shareWa', '#shareX', '#shareFb'].forEach(function (sel) {
          var el = document.querySelector(sel);
          if (el) el.style.display = 'none';
        });
      }

      applyLinks();
    },

    // Lo llama la app cada vez que se abre o cambia de nota.
    setNote: function (note, ctx) {
      var url = note && note.id ? ctx.noteUrl(note) : ctx.siteUrl();
      state.note = note || null;
      state.url = url;
      state.title = (note && note.title) || SITE_NAME;
      applyLinks();
    },

    // Estado actual, expuesto para tests y para que otro plugin pueda reusarlo.
    getState: function () {
      return { title: state.title, url: state.url, links: destinations(state.title, state.url) };
    }
  });
})(window.TribunaPlugins);
