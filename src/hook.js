/*
 * Temu Cart Insight - hook de red (MAIN world).
 *
 * Corre antes que el bundle de Temu, asi que intercepta todas las respuestas
 * del carrito aunque el contenido se pinte despues. No modifica nada: solo
 * lee el JSON y lo reenvia al content script por postMessage.
 */
(() => {
  'use strict';
  if (window.__temuCartInsightHooked) return;
  window.__temuCartInsightHooked = true;

  const CHANNEL = 'temu-cart-insight';
  const CART_URL_RE = /(uranus_cart|shopping_cart|cart_modify|cart\/query|\/cart)/i;
  const MAX_ITEMS = 200;
  const last = new Map();

  const post = (url, json) => {
    try {
      if (!json || typeof json !== 'object') return;
      const fingerprint = url + '|' + JSON.stringify(json).length;
      const now = Date.now();
      if (last.has(fingerprint) && now - last.get(fingerprint) < 800) return;
      last.set(fingerprint, now);
      window.postMessage({ source: CHANNEL, type: 'cart-json', url, json }, window.location.origin);
    } catch (_) {
      /* respuesta no serializable: se ignora */
    }
  };

  const looksLikeCart = (json) => {
    if (!json || typeof json !== 'object') return false;
    const r = json.result || json.data || json;
    return Boolean(
      (r && r.cart_list_info && r.cart_list_info.goods_sku_list) ||
      (r && r.goods_sku_list) ||
      (json.result && json.result.cart_list_info)
    );
  };

  // --- fetch -------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = nativeFetch.apply(this, arguments);
      if (!CART_URL_RE.test(url)) return promise;
      return promise.then((response) => {
        try {
          response.clone().json().then((json) => {
            if (looksLikeCart(json)) post(url, json);
          }).catch(() => {});
        } catch (_) {}
        return response;
      });
    };
  }

  // --- XMLHttpRequest ----------------------------------------------------
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__temuCiUrl = String(url || ''); } catch (_) {}
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__temuCiUrl || '';
      if (CART_URL_RE.test(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
            const json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            if (looksLikeCart(json)) post(url, json);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return nativeSend.apply(this, arguments);
  };

  // --- snapshot inicial --------------------------------------------------
  // Algunas cargas pintan el carrito desde SSR: si hay datos en rawData.store
  // se emiten una sola vez como fuente de respaldo.
  const emitSnapshot = () => {
    try {
      const store = window.rawData && window.rawData.store;
      if (!store) return;
      const seen = new Set();
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return null;
        seen.add(obj);
        if (obj.cart_list_info || obj.goods_sku_list) return obj;
        for (const key of Object.keys(obj)) {
          const found = walk(obj[key], depth + 1);
          if (found) return found;
        }
        return null;
      };
      const found = walk(store, 0);
      if (found && MAX_ITEMS > 0) post('window.rawData.store', { result: found });
    } catch (_) {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(emitSnapshot, 1200), { once: true });
  } else {
    setTimeout(emitSnapshot, 1200);
  }
})();
