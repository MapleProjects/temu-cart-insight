# Temu Cart Insight

Extension de Chrome/Chromium (Manifest V3) que reemplaza los precios confusos del
carrito de Temu por el precio real por unidad y el neto de cada fila, y limpia el
ruido de descuentos del panel y de las paginas de listado.

## Que hace

Carrito:

- Reemplaza el precio de cada fila por el desglose por unidad, de izquierda a
  derecha: `$6,37 + $9,47 + $9,48` y debajo `total: $25,32`. Cuando todas las
  unidades valen lo mismo muestra `$7,68 × 3`.
- La primera tanda de unidades va al precio de oferta que muestra Temu y el
  resto al promedio que queda tras prorratear los descuentos del panel.
- Oculta el precio tachado, el badge de porcentaje y la linea
  "tras aplicar promociones a" que Temu usa para marear.
- Deja en el panel solo el descuento por tiempo limitado, el cupon y el total.
- Anade una linea con el precio real promedio por unidad del pedido.
- La suma de los netos de cada fila cuadra al centavo con el total de Temu.

Inicio, busqueda y ficha de producto:

- Oculta precios tachados, badges "-NN%" y textos de "Precio original",
  "Ahorra ..." y "descuento aplicado". El precio final queda intacto.

## Fuentes de datos

1. `src/hook.js` corre en el mundo MAIN y en `document_start`: intercepta
   `fetch` y `XMLHttpRequest` de la API del carrito
   (`uranus_cart`, `shopping_cart`) y reenvia el JSON al content script por
   `postMessage`. Tambien intenta un snapshot de `window.rawData.store`.
2. `src/content.js` usa ese JSON como fuente primaria (limites, precio base,
   desglose por unidad) y el DOM como fuente viva, porque Temu repinta precios
   y cantidades sin volver a pedir el carrito.

## Modelo de calculo

```
base_fila     = precio base sin promos * cantidad
suma_base     = subtotal intermedio del panel (o suma de bases)
descuentos    = descuento especifico + tiempo limitado + cupon
neto_fila     = base_fila - descuentos * (base_fila / suma_base)
precio_real_u = neto_fila / cantidad
```

La suma de `neto_fila` se ajusta al centavo para coincidir con el total del
panel. Verificado contra un carrito real de 7 unidades: las filas suman el
total exacto de Temu.

## Instalacion

Descarga la ultima version desde
https://github.com/MapleProjects/temu-cart-insight/releases/latest
y descomprime el ZIP.

1. Abrir `chrome://extensions` (o `vivaldi://extensions`).
2. Activar "Modo de desarrollador".
3. "Cargar descomprimida" y elegir la carpeta descomprimida.
4. Recargar la pestana de Temu.

Para desarrollar: cargar esta misma carpeta del repositorio y usar
`./scripts/package.sh` para generar el ZIP de cada version.

## Publicar una version

1. Subir el numero en `manifest.json`.
2. `./scripts/package.sh`
3. `gh release create v<version> dist/temu-cart-insight-<version>.zip --notes-file <notas> --latest`

## Estructura

```
manifest.json
src/hook.js       interceptacion de red (MAIN world)
src/content.js    calculo, reemplazo de precios y limpieza (ISOLATED world)
icons/            16, 48 y 128 px
```

## Limitaciones

- Los selectores del DOM de Temu son clases hasheadas: se usan anclas
  semanticas (`.shopCartGoodsItemCheckbox`, enlaces `goods_id`, textos). Si
  Temu cambia el carrito, hay que ajustar `findRow` y `findPromoLine`.
- El precio por unidad de una fila es una asignacion proporcional del descuento
  total: el importe garantizado es el total del pedido, no el reparto interno.
- Si Temu anade cargos de envio o impuestos, entran en el total pero no en el
  prorrateo por fila.
