/*
 * Temu Cart Insight - content script (ISOLATED world).
 *
 * Objetivo: reemplazar los precios engañosos del carrito por el precio real
 * por unidad y el neto de la fila, y limpiar el ruido de descuentos del panel.
 *
 * Fuentes: JSON del carrito capturado por hook.js (primaria) + DOM (vivo).
 *
 * Calculo (verificado contra el panel de Temu):
 *   base_fila = "precio base sin promos" x cantidad
 *   suma_base = subtotal intermedio del panel
 *   neto_fila = base_fila - (descuentos del panel prorrateados por base_fila)
 *   precio_real_unidad = neto_fila / cantidad
 */
(() => {
  'use strict';
  if (window.__temuCartInsightLoaded) return;
  window.__temuCartInsightLoaded = true;

  const CHANNEL = 'temu-cart-insight';
  const ORANGE = 'rgb(251, 119, 1)';
  const CURRENCY = /\$|€|£/;

  const state = {
    apiIndex: new Map(),   // goods_id -> datos de la API
    memo: new Map(),       // goods_id -> datos ya leidos del DOM
    priceSlot: new Map(),  // goods_id -> nodo donde vive el precio mostrado
    hidden: new WeakSet(),
    timer: null
  };

  // ---------------------------------------------------------------- utils
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const money = (n) => (n == null || !Number.isFinite(n) ? '—' : '$' + n.toFixed(2).replace('.', ','));
  const priceLike = (t) => CURRENCY.test(t) && /\d/.test(t);

  function parseAmount(text) {
    if (text == null) return null;
    // Solo el primer importe: los nodos de Temu concatenan el valor dos veces.
    const match = norm(text).match(/-?\s*\$?\s*\d[\d.,]*/);
    if (!match) return null;
    let raw = match[0].replace(/[^\d.,-]/g, '');
    if (!raw) return null;
    const negative = raw.startsWith('-');
    raw = raw.replace(/-/g, '');
    if (/,\d{1,2}$/.test(raw)) raw = raw.replace(/\./g, '').replace(',', '.');
    else if (/\.\d{1,2}$/.test(raw) && /^\d{1,3}(\.\d{3})+/.test(raw)) raw = raw.replace(/\./g, '');
    else raw = raw.replace(/,/g, '');
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return null;
    // Los importes siempre son de dos decimales: cualquier resto es ruido del DOM.
    const rounded = Math.round(value * 100) / 100;
    return negative ? -rounded : rounded;
  }

  const textOf = (items) =>
    (Array.isArray(items) ? items : []).reduce((acc, it) => acc + (it && typeof it.text === 'string' ? it.text : ''), '');

  // ------------------------------------------------------------ API input
  function cartListFrom(json) {
    if (!json || typeof json !== 'object') return null;
    const result = json.result || json.data || json;
    if (result.cart_list_info && Array.isArray(result.cart_list_info.goods_sku_list)) return result.cart_list_info.goods_sku_list;
    if (Array.isArray(result.goods_sku_list)) return result.goods_sku_list;
    return null;
  }

  function indexApi(json) {
    const list = cartListFrom(json);
    if (!list) return;
    for (const item of list) {
      const base = item.base_goods_info || {};
      const sku = item.sku_info || {};
      const ext = sku.extend_map || {};
      let amountExtend = {};
      try {
        amountExtend = ext.amount_extend ? JSON.parse(ext.amount_extend) : {};
      } catch (_) {}

      const limitLabel = norm(textOf((item.limit_tag_text_new || {}).display_items));
      const limitMatch = limitLabel.match(/l[ií]mite\s*(\d+)/i);

      const entry = {
        goodsId: String(base.goods_id || ''),
        qty: sku.sku_quantity != null ? Number(sku.sku_quantity) : null,
        selected: item.is_selected === 1,
        strike: parseAmount(textOf(sku.market_price_text)) || (amountExtend.underline_price != null ? amountExtend.underline_price / 100 : null),
        shown: sku.sku_price != null ? sku.sku_price / 100 : null,
        baseUnit: item.before_promotion_amount != null
          ? item.before_promotion_amount / 100
          : (sku.before_promotion_amount != null
            ? sku.before_promotion_amount / 100
            : (amountExtend.unit_price != null ? amountExtend.unit_price / 100 : null)),
        lineNet: ext.cart_goods_amount_after_promotion != null ? Number(ext.cart_goods_amount_after_promotion) / 100 : null,
        limit: limitMatch ? parseInt(limitMatch[1], 10) : null
      };
      if (entry.goodsId) state.apiIndex.set(entry.goodsId, entry);
    }
  }

  // ------------------------------------------------------------- DOM rows
  function findRow(checkbox) {
    let row = checkbox;
    let depth = 0;
    while (row && row.parentElement && depth < 12) {
      if (row.querySelectorAll('a[href*="goods_id="]').length === 1 && row.querySelector('input')) return row;
      row = row.parentElement;
      depth += 1;
    }
    return null;
  }

  // La linea "tras aplicar promociones a $X" contiene etiqueta + importe en un
  // mismo nodo. Se devuelve ese nodo (no el span de la etiqueta).
  function findPromoLine(root) {
    const candidates = [...root.querySelectorAll('span,div')].filter((el) => {
      const text = norm(el.textContent);
      return /^(?:tras aplicar promociones|precio base sin promos)/i.test(text) && priceLike(text) && text.length < 64;
    });
    return candidates[0] || null;
  }

  function readRow(row, goodsId) {
    const memo = state.memo.get(goodsId) || {};
    const api = state.apiIndex.get(goodsId) || {};
    const out = { ...memo };

    const input = row.querySelector('input');
    out.qty = input ? parseInt(input.value, 10) || 0 : memo.qty || 0;

    const rowText = norm(row.innerText);
    const limitMatch = rowText.match(/l[ií]mite\s*(\d+)/i);
    if (limitMatch) out.limit = parseInt(limitMatch[1], 10);

    // Variante elegida (color y talla). El precio cambia segun la variante, asi
    // que se guarda para no confundir dos filas del mismo producto.
    if (!out.variant) {
      const spec = [...row.querySelectorAll('div,span')].find((el) => {
        const t = norm(el.textContent);
        return t.length > 3 && t.length < 90 && /(talla|tamaño de etiqueta|color)\s*:/i.test(t) && !/\$/.test(t);
      });
      if (spec) out.variant = norm(spec.textContent);
    }

    const promo = findPromoLine(row);
    if (promo) {
      out.promoNode = promo;
      const m = norm(promo.textContent).match(/(?:promociones a|promos)\s*(\$?\s?[\d.,]+)/i);
      const value = m ? parseAmount(m[1]) : null;
      if (value != null) out.baseUnit = value;
    }

    // Precio mostrado (naranja) solo la primera vez: despues lo reemplazamos.
    if (!state.priceSlot.get(goodsId)) {
      const prev = promo && promo.previousElementSibling;
      if (prev && priceLike(norm(prev.textContent)) && norm(prev.textContent).length < 24) {
        state.priceSlot.set(goodsId, prev);
        if (out.shown == null) out.shown = parseAmount(norm(prev.textContent));
      } else {
        const leaves = [...row.querySelectorAll('span,div,b,strong')].filter((el) => !el.children.length && norm(el.textContent));
        let strike = null;
        const orange = [];
        for (const el of leaves) {
          const style = getComputedStyle(el);
          const text = norm(el.textContent);
          if (!priceLike(text)) continue;
          if (style.textDecorationLine.includes('line-through') && strike == null) strike = parseAmount(text);
          if (style.color === ORANGE) orange.push(el);
        }
        if (strike != null) out.strike = strike;
        if (orange.length) state.priceSlot.set(goodsId, orange[0].parentElement || orange[0]);
      }
    }

    // Relleno desde la API cuando el DOM no alcanza.
    if (out.baseUnit == null && api.baseUnit != null) out.baseUnit = api.baseUnit;
    if (out.shown == null && api.shown != null) out.shown = api.shown;
    if (out.limit == null && api.limit != null) out.limit = api.limit;
    if (out.strike == null && api.strike != null) out.strike = api.strike;

    state.memo.set(goodsId, out);
    return out;
  }

  function domRows() {
    const rows = [];
    for (const box of document.querySelectorAll('.shopCartGoodsItemCheckbox')) {
      const row = findRow(box);
      if (!row) continue;
      const radio = box.querySelector('[role="radio"],[aria-checked]');
      const link = row.querySelector('a[href*="goods_id="]');
      const goodsId = (String(link && link.getAttribute('href')).match(/goods_id=(\d+)/) || [])[1] || row.innerText.slice(0, 40);
      const data = readRow(row, goodsId);
      rows.push({
        rowEl: row,
        goodsId,
        selected: radio ? radio.getAttribute('aria-checked') !== 'false' : true,
        qty: data.qty || 0,
        limit: data.limit || null,
        strike: data.strike || null,
        baseUnit: data.baseUnit != null ? data.baseUnit : null,
        shown: data.shown != null ? data.shown : null,
        name: norm(row.innerText).slice(0, 70)
      });
    }
    return rows;
  }

  // ----------------------------------------------------------- panel parse
  function panelRoot() {
    return (
      document.querySelector('[class*="g_p_sum_wr"]') ||
      [...document.querySelectorAll('div')].filter((el) => /Resumen del pedido/.test(el.innerText || '') && (el.innerText || '').length < 900).pop() ||
      null
    );
  }

  function parsePanel() {
    const root = panelRoot();
    if (!root) return null;

    const panel = { itemsTotal: null, itemDiscount: null, subtotal: null, specificDiscount: null, limitedDiscount: null, coupon: null, total: null };
    const amountAfterColon = (text) => {
      const m = text.match(/:\s*(-?\$?\s?[\d.,]+)/);
      return m ? parseAmount(m[1]) : null;
    };

    // Se lee por textContent: las filas que ocultamos siguen aportando datos.
    const labelRow = [...root.querySelectorAll('div,span')].find(
      (el) => /^total de art[ií]culos/i.test(norm(el.textContent)) && norm(el.textContent).length < 80
    );
    const rows = labelRow && labelRow.parentElement ? [...labelRow.parentElement.children] : [...root.querySelectorAll('div')];

    for (const row of rows) {
      const text = norm(row.textContent);
      if (!text || text.length > 160) continue;
      if (/^total de art[ií]culos/i.test(text)) panel.itemsTotal = amountAfterColon(text);
      else if (/^descuento de art[ií]culo/i.test(text)) panel.itemDiscount = amountAfterColon(text);
      else if (/^descuento de temu para un art[ií]culo/i.test(text)) panel.specificDiscount = amountAfterColon(text);
      else if (/^descuento por tiempo limitado/i.test(text)) panel.limitedDiscount = amountAfterColon(text);
      else if (/^cup[oó]n/i.test(text)) panel.coupon = amountAfterColon(text);
      else if (/^total\b/i.test(text) && /[\d]/.test(text)) {
        const value = parseAmount(text.replace(/^total/i, ''));
        if (value != null) panel.total = value;
      }
    }

    if (panel.subtotal == null && panel.itemsTotal != null && panel.itemDiscount != null) {
      panel.subtotal = Math.abs(panel.itemsTotal) - Math.abs(panel.itemDiscount);
    }
    if (panel.total == null && panel.subtotal != null) {
      panel.total = panel.subtotal - (Math.abs(panel.specificDiscount || 0) + Math.abs(panel.limitedDiscount || 0) + Math.abs(panel.coupon || 0));
    }
    return panel;
  }

  // --------------------------------------------------------------- calculo
  function compute() {
    const rows = domRows().filter((r) => r.selected && r.qty > 0);
    const panel = parsePanel() || {};
    const withBase = rows.filter((r) => r.baseUnit != null);
    const sumBase = withBase.reduce((acc, r) => acc + r.baseUnit * r.qty, 0);

    const subtotal = panel.subtotal != null ? panel.subtotal : sumBase;
    state.lastSubtotal = subtotal;
    const discounts =
      Math.abs(panel.specificDiscount || 0) + Math.abs(panel.limitedDiscount || 0) + Math.abs(panel.coupon || 0);
    const total = panel.total != null ? panel.total : subtotal - discounts;

    const allocation = [];
    const denom = sumBase || 1;
    for (const row of withBase) {
      const lineBase = row.baseUnit * row.qty;
      const net = lineBase - discounts * (lineBase / denom);
      allocation.push({ row, lineBase, net: Math.round(net * 100) / 100, avgUnit: 0 });
    }

    // Cuadre exacto al centavo con el total de Temu.
    if (allocation.length) {
      const cents = allocation.map((a) => Math.round(a.net * 100));
      const diff = Math.round(total * 100) - cents.reduce((x, y) => x + y, 0);
      if (diff !== 0) {
        let maxIdx = 0;
        cents.forEach((c, i) => { if (c > cents[maxIdx]) maxIdx = i; });
        cents[maxIdx] += diff;
      }
      allocation.forEach((a, i) => {
        a.net = cents[i] / 100;
        a.avgUnit = a.net / a.row.qty;
      });
    }

    const totalQty = rows.reduce((acc, r) => acc + r.qty, 0);
    const sumNet = allocation.reduce((acc, a) => acc + a.net, 0);

    return {
      allocation,
      panel: {
        limitedDiscount: Math.abs(panel.limitedDiscount || 0),
        coupon: Math.abs(panel.coupon || 0),
        total
      },
      totals: { totalQty, sumNet, avgUnit: sumNet / (totalQty || 1) }
    };
  }

  // ------------------------------------------------------------- pintado
  // Reparte el neto de la fila en centavos por unidad: la primera tanda al
  // precio de oferta mostrado y el resto al promedio que queda.
  function unitCents(entry) {
    const { row } = entry;
    const qty = Math.max(1, row.qty);
    const totalCents = Math.round(entry.net * 100);
    const promo = row.shown;
    const limit = row.limit && row.limit > 0 && row.limit < qty ? row.limit : qty;

    const uniform = () => {
      const base = Math.floor(totalCents / qty);
      const rem = totalCents - base * qty;
      return Array.from({ length: qty }, (_, i) => base + (i === qty - 1 ? rem : 0));
    };

    if (limit === qty || promo == null) return uniform();
    const promoTotal = Math.round(promo * 100) * limit;
    const restQty = qty - limit;
    const rest = totalCents - promoTotal;
    if (rest <= 0) return uniform();

    const base = Math.floor(rest / restQty);
    const rem = rest - base * restQty;
    const cents = Array.from({ length: limit }, () => Math.round(promo * 100));
    for (let i = 0; i < restQty; i += 1) cents.push(base + (i === restQty - 1 ? rem : 0));
    return cents;
  }

  function paintPrice(entry) {
    const { row } = entry;
    const slot = state.priceSlot.get(row.goodsId);
    if (!slot || !document.contains(slot)) return;

    const cents = unitCents(entry);
    const uniform = cents.every((c) => c === cents[0]);
    const unitsText = uniform
      ? `${money(cents[0] / 100)}${row.qty > 1 ? ` × ${row.qty}` : ''}`
      : cents.map((c) => money(c / 100)).join(' + ');

    const signature = unitsText + '|' + money(entry.net);
    const current = norm(slot.textContent);
    if (slot.getAttribute('data-temu-ci-sig') === signature && current.includes(unitsText.replace(/\s+/g, ' '))) return;

    slot.textContent = '';
    slot.style.textDecoration = 'none';
    // El contenedor de Temu recorta a una linea: se libera para el total.
    slot.style.overflow = 'visible';
    slot.style.height = 'auto';
    slot.style.maxHeight = 'none';

    const box = document.createElement('div');
    box.style.cssText =
      'display:flex;flex-direction:column;align-items:flex-start;gap:5px;width:100%;text-decoration:none';

    const units = document.createElement('div');
    units.textContent = unitsText;
    units.style.cssText =
      'display:block;color:#fb7701;font-weight:700;font-size:15px;line-height:1.4;text-decoration:none;' +
      'white-space:normal;word-break:break-word;max-width:100%';
    box.append(units);

    if (row.qty > 1) {
      const total = document.createElement('div');
      total.textContent = `total: ${money(entry.net)}`;
      total.style.cssText =
        'display:block;color:#111;font-size:15px;font-weight:700;line-height:1.4;text-decoration:none';
      box.append(total);
    }

    slot.append(box);
    slot.setAttribute('data-temu-ci-sig', signature);
    slot.setAttribute('data-temu-ci-price', '1');
  }

  function hideNode(node) {
    if (!node || state.hidden.has(node)) return;
    node.style.setProperty('display', 'none', 'important');
    state.hidden.add(node);
  }

  // Limpia la vista: fuera tachados, badges de porcentaje, linea base y ruido
  // de descuentos del panel. Solo quedan cupon, tiempo limitado y total.
  function cleanNoise(allocation) {
    for (const entry of allocation) {
      const { row } = entry;
      const root = row.rowEl;
      if (!root) continue;

      // Tachado y badge de porcentaje
      for (const el of root.querySelectorAll('span,div,b,strong,s')) {
        const text = norm(el.textContent);
        if (!text || text.length > 24) continue;
        if (getComputedStyle(el).textDecorationLine.includes('line-through') && priceLike(text)) hideNode(el);
        else if (/^-\d{1,2}%/.test(text)) hideNode(el);
      }

      // Linea "precio base sin promos $X"
      const promo = findPromoLine(root);
      if (promo) hideNode(promo);

      // Etiqueta de limite: solo molesta cuando no hay exceso
      const limitTag = [...root.querySelectorAll('span,div')].find(
        (el) => /^l[ií]mite\s*\d+/i.test(norm(el.textContent)) && norm(el.textContent).length < 24
      );
      if (limitTag) {
        const limit = entry.row.limit || 0;
        if (!limit || entry.row.qty <= limit) hideNode(limitTag);
      }
    }

    const root = panelRoot();
    if (!root) return;
    const labelRow = [...root.querySelectorAll('div,span')].find(
      (el) => /^total de art[ií]culos/i.test(norm(el.textContent)) && norm(el.textContent).length < 60
    );
    if (!labelRow) return;
    const container = labelRow.parentElement;
    if (!container) return;
    const subtotalValue = state.lastSubtotal;

    for (const child of [...container.children]) {
      const text = norm(child.innerText || child.textContent);
      if (!text) continue;
      const noise =
        /^total de art[ií]culos/i.test(text) ||
        /^descuento de art[ií]culo/i.test(text) ||
        /^descuento de temu para un art[ií]culo/i.test(text);
      if (noise) {
        hideNode(child);
        continue;
      }
      if (/^[-+]?\$?\s?[\d.,]+$/.test(text)) {
        const value = parseAmount(text);
        if (value != null && subtotalValue != null && Math.abs(value - subtotalValue) < 0.011) hideNode(child);
      }
    }
  }

  let summaryHost = null;
  function paintSummary(result) {
    const root = panelRoot();
    if (!root) return;
    if (!summaryHost || !document.contains(summaryHost)) {
      summaryHost = document.createElement('div');
      summaryHost.setAttribute('data-temu-ci', 'summary');
      summaryHost.style.cssText =
        'margin-top:8px;padding:7px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;' +
        'font:600 12px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;color:#111';
      root.insertAdjacentElement('afterend', summaryHost);
    }
    summaryHost.innerHTML = `Precio real por unidad: <span style="color:#b34900">${money(result.totals.avgUnit)}</span>`;
  }

  // Limpieza en inicio, busqueda y detalle: fuera tachados, "-NN%" y textos de
  // ahorro. El precio final se queda tal cual, ya es el precio real unitario.
  function cleanListPage() {
    const nodes = document.querySelectorAll('span,div,b,strong,s,em');
    for (const el of nodes) {
      if (el.children.length > 2) continue;
      const text = norm(el.textContent);
      if (!text || text.length > 34) continue;
      if (/^-\d{1,2}%/.test(text)) {
        hideNode(el);
        continue;
      }
      if (/^precio original/i.test(text) || /^ahorra\b/i.test(text) || /descuento aplicado/i.test(text)) {
        hideNode(el);
        continue;
      }
      if (CURRENCY.test(text) && /\d/.test(text)) {
        if (getComputedStyle(el).textDecorationLine.includes('line-through')) hideNode(el);
      }
    }
  }

  // Vista rapida del producto: Temu muestra "Est. $X" por unidad, que no
  // coincide con lo que cobra el carrito. Si el producto esta en el carrito se
  // sustituye por el precio real y su total.
  // El nombre de la fila trae distintivos pegados ("CASI AGOTADO(S) ..."), que
  // el titulo del modal no tiene: se limpian antes de comparar.
  function cleanName(text) {
    return norm(text)
      .replace(/^imagen del art[ií]culo\s*/i, '')
      .replace(/^selecci[oó]n destacada\s*/i, '')
      .replace(/^(casi agotado(\(s\))?|agotado|nuevo|choice|mega oferta|black friday)\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  const SNAPSHOT_KEY = 'temuCartInsightSnapshot';
  state.snapshot = [];

  // Guarda el ultimo carrito calculado para poder corregir los paneles de
  // producto en otras paginas (portada, busqueda, ficha).
  function persistRows(rows) {
    if (!rows || !rows.length) return;
    const sig = JSON.stringify(rows.map((r) => [r.goodsId, r.qty, r.net]));
    if (state.snapSig === sig) return;
    state.snapSig = sig;
    state.snapshot = rows;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [SNAPSHOT_KEY]: { ts: Date.now(), rows } });
      }
    } catch (err) {
      /* sin contexto de extension (pruebas por inyeccion manual) */
    }
  }

  function persistSnapshot(result) {
    persistRows(
      result.allocation.map((a) => ({
        goodsId: String(a.row.goodsId || ''),
        name: a.row.name,
        qty: a.row.qty,
        net: a.net,
        units: unitCents(a),
        variant: a.row.variant || '',
      }))
    );
  }

  function loadSnapshot() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(SNAPSHOT_KEY, (data) => {
        const snap = data && data[SNAPSHOT_KEY];
        if (snap && Array.isArray(snap.rows) && Date.now() - snap.ts < 6 * 60 * 60 * 1000) {
          state.snapshot = snap.rows;
          schedule();
        }
      });
    } catch (err) {
      /* idem */
    }
  }

  // Filas del carrito disponibles: las vivas si estamos en el carrito, o las
  // guardadas si estamos en otra pagina.
  function candidates() {
    const live = state.last && state.last.allocation;
    if (live && live.length) {
      return live.map((a) => ({
        goodsId: String(a.row.goodsId || ''),
        name: a.row.name,
        qty: a.row.qty,
        net: a.net,
        units: unitCents(a),
      }));
    }
    return state.snapshot || [];
  }

  // El precio cambia segun la variante (modelo, color, talla). Se comparan las
  // etiquetas que aparecen en ambos lados y se descarta la fila cuando chocan.
  function sizesIn(text) {
    const out = [];
    const re = /(?:talla|tamaño de etiqueta|tamaño|size)[^:]{0,14}:\s*([^\s|/]{1,14})/gi;
    let m;
    while ((m = re.exec(text))) out.push(m[1].toLowerCase());
    return out;
  }

  function colorIn(text) {
    const m = norm(text).match(/color\s*:\s*([^|]{2,50})/i);
    return m ? m[1].toLowerCase().trim() : '';
  }

  function variantFits(rowVariant, panelText) {
    if (!rowVariant) return true;

    const rowSizes = sizesIn(rowVariant);
    const panelSizes = sizesIn(panelText);
    if (rowSizes.length && panelSizes.length) {
      const numeric = (s) => /^\d+$/.test(s);
      const comparable = rowSizes.every(numeric) === panelSizes.every(numeric);
      if (comparable && !rowSizes.some((s) => panelSizes.includes(s))) return false;
    }

    const rowColor = colorIn(rowVariant);
    const panelColor = colorIn(panelText);
    if (rowColor && panelColor && !rowColor.includes(panelColor) && !panelColor.includes(rowColor)) {
      return false;
    }
    return true;
  }

  function matchCandidate(root, titleText) {
    const all = candidates();
    if (!all.length) return null;
    const panelText = norm(root.innerText || root.textContent || '');
    const list = all.filter((c) => variantFits(c.variant, panelText));
    if (!list.length) return null;

    const hrefs = [...root.querySelectorAll('a[href*="goods_id="]')].map((a) => a.getAttribute('href') || '');
    for (const href of hrefs) {
      const m = href.match(/goods_id=(\d+)/);
      if (!m) continue;
      const hit = list.find((c) => c.goodsId === m[1]);
      if (hit) return hit;
    }

    const target = cleanName(titleText);
    if (target.length < 12) return null;
    return (
      list.find((c) => {
        const name = cleanName(c.name);
        if (name.length < 12) return false;
        const key = target.slice(0, 20);
        const own = name.slice(0, 20);
        return own === key || name.startsWith(key) || target.startsWith(own);
      }) || null
    );
  }

  function cleanQuickView() {
    const roots = new Set([...document.querySelectorAll('[role="dialog"]')]);
    for (const el of document.querySelectorAll('div')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (cs.zIndex === 'auto') continue;
      const w = el.offsetWidth;
      if (w < 200 || w > 760 || el.offsetHeight < 120) continue;
      roots.add(el);
    }

    for (const root of roots) {
      if (root.getBoundingClientRect().width < 200) continue;
      if (root.querySelector('[data-temu-ci-qv]')) continue;

      const blocks = [...root.querySelectorAll('div')].filter((el) => {
        const t = norm(el.textContent);
        if (!/^est\.?\s*\$/i.test(t)) return false;
        if (t.length > 260) return false;
        if (/(agrega|comprar|talla|color|cant\.)/i.test(t)) return false;
        return true;
      });
      if (!blocks.length) continue;
      const block = blocks.reduce((a, b) => (b.textContent.length > a.textContent.length ? b : a));

      const titles = [...root.querySelectorAll('div,h1,h2')].filter((el) => {
        if (el.querySelector('script,style')) return false;
        const t = norm(el.textContent);
        if (t.length < 30 || t.length > 300) return false;
        if (/\$/.test(t)) return false;
        if (/vendido por|ventas|de este vendedor/i.test(t)) return false;
        return el.children.length <= 2;
      });
      const titleEl = titles.reduce((a, b) => (!a || b.textContent.length > a.textContent.length ? b : a), null);
      if (!titleEl) continue;

      const entry = matchCandidate(root, titleEl.textContent);
      if (!entry) continue;

      const cents = entry.units || [];
      const uniform = cents.length > 0 && cents.every((c) => c === cents[0]);
      const unitsText = !cents.length
        ? money(entry.net)
        : uniform
        ? `${money(cents[0] / 100)}${entry.qty > 1 ? ` × ${entry.qty}` : ''}`
        : cents.map((c) => money(c / 100)).join(' + ');

      block.textContent = '';
      block.setAttribute('data-temu-ci-qv', '1');
      block.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-decoration:none';

      const head = document.createElement('div');
      head.textContent = unitsText;
      head.style.cssText = 'color:#fb7701;font-weight:700;font-size:15px;line-height:1.35;text-decoration:none';
      block.append(head);

      if (entry.qty > 1) {
        const tot = document.createElement('div');
        tot.textContent = `total: ${money(entry.net)}`;
        tot.style.cssText = 'color:#111;font-size:15px;font-weight:700;line-height:1.35;text-decoration:none';
        block.append(tot);
      }

      const note = document.createElement('div');
      note.textContent = 'precio real en tu carrito';
      note.style.cssText = 'color:#777;font-size:11px;line-height:1.3;text-decoration:none';
      block.append(note);
    }
  }

  // Minicarrito lateral que Temu muestra en todas las paginas: repite el precio
  // por unidad como si fuera el precio real. Se corrige con el ultimo carrito
  // conocido.
  function cleanMiniCart() {
    for (const media of document.querySelectorAll('[aria-label*="imagen del art"]')) {
      const title = media.getAttribute('aria-label') || '';

      let row = media;
      for (let i = 0; i < 4 && row.parentElement; i += 1) {
        row = row.parentElement;
        if (/\$\s?\d/.test(row.innerText || '')) break;
      }
      if (!row || row.getAttribute('data-temu-ci-mini-row') === '1') continue;

      const price = [...row.querySelectorAll('div,span')].find(
        (el) =>
          !el.children.length &&
          /^\$?\s*\d{1,4}[.,]\d{2}$/.test(norm(el.innerText || el.textContent)) &&
          el.getAttribute('data-temu-ci-mini') !== '1'
      );
      if (!price || !price.parentElement) continue;

      const box = price.parentElement;
      if (box.getAttribute('data-temu-ci-mini') === '1') continue;
      const entry = matchCandidate(row, title);
      if (!entry) continue;

      const avg = entry.qty > 1 ? entry.net / entry.qty : entry.net;
      box.textContent = '';
      box.setAttribute('data-temu-ci-mini', '1');
      row.setAttribute('data-temu-ci-mini-row', '1');
      box.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:1px;text-decoration:none';

      const top = document.createElement('div');
      top.textContent = entry.qty > 1 ? `${money(avg)} × ${entry.qty}` : money(entry.net);
      top.style.cssText = 'color:#fb7701;font-weight:700;font-size:13px;line-height:1.3;text-decoration:none';
      box.append(top);

      if (entry.qty > 1) {
        const tot = document.createElement('div');
        tot.textContent = `total: ${money(entry.net)}`;
        tot.style.cssText = 'color:#111;font-size:11px;font-weight:600;line-height:1.3;text-decoration:none';
        box.append(tot);
      }
    }
  }

  // Tarjetas de listado y portada: si el producto esta en el carrito se muestra
  // el precio real que paga el usuario, no el precio de vitrina.
  function paintCards() {
    const list = (candidates() || []).filter((r) => r && r.name && r.net);
    if (!list.length) return;
    const keys = list.map((r) => ({ row: r, key: cleanName(r.name) }));

    for (const link of document.querySelectorAll('a[href^="/ec/"], a[href*="goods.html"]')) {
      let card = link;
      let leaf = null;
      for (let i = 0; i < 6 && card.parentElement; i += 1) {
        card = card.parentElement;
        if (card.querySelectorAll('a[href^="/ec/"], a[href*="goods.html"]').length > 1) break;
        leaf = [...card.querySelectorAll('div,span')].find(
          (el) => !el.children.length && /^\$?\s*\d{1,4}[.,]\d{2}$/.test(norm(el.textContent))
        );
        if (leaf) break;
      }
      if (!leaf || leaf.getAttribute('data-temu-ci-card') === '1') continue;
      if (!leaf.parentElement) continue;

      const titles = [...card.querySelectorAll('div,span')].filter((el) => {
        const t = norm(el.textContent);
        return (
          t.length >= 20 &&
          t.length <= 320 &&
          !/\$/.test(t) &&
          el.children.length <= 3 &&
          !/termina en|ventas|env[ií]o|anuncio|vendedor|descuento|compra/i.test(t)
        );
      });
      const pure = titles.filter((el) => !el.children.length);
      const titleEl = (pure.length ? pure : titles).reduce(
        (a, b) => (!a || b.textContent.length > a.textContent.length ? b : a),
        null
      );
      if (!titleEl) continue;

      const key = cleanName(titleEl.textContent);
      if (key.length < 12) continue;
      const hits = keys.filter(
        (k) => k.key.slice(0, 20) === key.slice(0, 20) || k.key.startsWith(key.slice(0, 20))
      );
      if (hits.length !== 1) continue;

      const row = hits[0].row;
      const avg = row.qty > 1 ? row.net / row.qty : row.net;
      const box = leaf.parentElement;
      if (box.getAttribute('data-temu-ci-card') === '1') continue;
      box.setAttribute('data-temu-ci-card', '1');
      box.textContent = '';

      const price = document.createElement('span');
      price.textContent = money(avg);
      price.style.cssText = 'color:#fb7701;font-weight:700';
      box.append(price);

      const note = document.createElement('span');
      note.textContent = ' en tu carrito';
      note.style.cssText = 'color:#888;font-size:11px;font-weight:400;margin-left:3px';
      box.append(note);
    }
  }

  // ------------------------------------------------------------ ciclo
  function run() {
    state.timer = null;
    try {
      const onCartPage = /shopping_cart/.test(location.pathname + location.search);
      const result = compute();
      state.last = result;
      if (!result.allocation.length) {
        cleanListPage();
        if (!onCartPage) cleanMiniCart();
        cleanQuickView();
        paintCards();
        return;
      }
      for (const entry of result.allocation) paintPrice(entry);
      cleanNoise(result.allocation);
      paintSummary(result);
      persistSnapshot(result);
      if (!onCartPage) cleanMiniCart();
      cleanQuickView();
      paintCards();
    } catch (err) {
      console.error('[Temu Cart Insight]', err);
    }
  }

  function schedule() {
    if (state.timer) return;
    state.timer = setTimeout(run, 150);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.type !== 'cart-json') return;
    if (!cartListFrom(data.json)) return;
    indexApi(data.json);
    schedule();
  });

  const start = () => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('input', schedule, true);
    document.addEventListener('change', schedule, true);
    document.addEventListener('click', schedule, true);
    loadSnapshot();
    schedule();
    setInterval(schedule, 2500);
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  // Punto de inspeccion para depurar el calculo desde la consola.
  window.__temuCi = {
    state,
    compute,
    parsePanel,
    setSnapshot: (rows) => {
      state.snapshot = rows;
      schedule();
    },
  };
})();
