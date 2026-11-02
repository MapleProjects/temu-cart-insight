# Ficha para la Chrome Web Store

Textos listos para copiar en el panel de desarrollador.

## Nombre (manifest, max 45)

Temu Cart Insight

## Descripcion corta (manifest, max 132)

Desglose real por unidad y total neto de cada fila del carrito de Temu, sin
ruido de descuentos enganosos.

## Descripcion larga (panel, Store listing)

Temu muestra en el carrito un precio por unidad que solo aplica a la primera
unidad de una oferta limitada, y reparte los descuentos de forma poco clara.
Temu Cart Insight calcula lo que de verdad vas a pagar y lo pone en el mismo
sitio donde miras el precio.

Que hace en el carrito

- Reemplaza el precio de cada fila por el desglose unidad por unidad, de
  izquierda a derecha. Ejemplo: 6,37 + 9,47 + 9,48, y debajo el total de ese
  articulo en el carrito.
- Cuando todas las unidades valen lo mismo resume el precio con la cantidad.
- Oculta el precio tachado, los badges de porcentaje y la linea "tras aplicar
  promociones a" que solo confunden.
- Deja en el resumen del pedido unicamente el descuento por tiempo limitado, el
  cupon y el total.
- La suma de los totales de cada fila coincide al centavo con el total que
  cobra Temu.

Que hace en el resto del sitio

- En inicio, busqueda y ficha de producto oculta precios originales tachados,
  porcentajes de descuento y textos de ahorro. El precio final queda intacto.

Privacidad

La extension trabaja solo en tu navegador. No envia datos a ningun servidor, no
guarda historial, no usa analitica ni publicidad.

Nota: la extension no modifica precios de compra ni el proceso de pago. Solo
cambia como se presenta la informacion de precio en pantalla.

## Categoria

Compras (Shopping). Idioma: espanol.

## Proposito unico (campo "Single purpose description")

Muestra el precio real por unidad y el total neto de cada articulo en el
carrito de Temu, y elimina los textos de descuento redundantes que impiden ver
ese precio.

## Justificacion de permisos

Host permission https://www.temu.com/*

La extension solo funciona en el carrito y en las listas de producto de Temu.
Necesita acceso a esa pagina para leer los precios y cantidades que muestra
Temu, calcular el neto por fila, reemplazar el texto del precio y ocultar los
elementos de descuento redundantes. No se inyecta en ningun otro sitio.

No se solicitan permisos de storage, tabs, cookies ni scripting.

## Declaracion de codigo remoto

No, no se usa codigo remoto. Todo el JavaScript viaja dentro del paquete.

## Practicas de datos (checkboxes)

- Datos recopilados: ninguno.
- Certificaciones de uso limitado: marcar todas, la extension no vende, no
  transfiere y no usa datos para fines ajenos a su funcion.

## Politica de privacidad (URL)

https://github.com/MapleProjects/temu-cart-insight/blob/main/PRIVACY.md

## Recursos graficos

- Icono de tienda 128x128: icons/icon128.png
- Captura 1280x800: store/screenshot-1.png
- Tile pequeno 440x280: store/promo-440x280.png
- Marquee 1400x560 (opcional, solo para destacados): pendiente

## Riesgos de revision a tener en cuenta

- La marca "Temu" aparece en el nombre. La politica de la tienda prohibe
  sugerir afiliacion. Mantener el aviso de no afiliacion en la descripcion y en
  la politica de privacidad, y no usar logos de Temu en los graficos.
- La extension altera la presentacion de precios de un sitio de terceros. En la
  justificacion conviene dejar explicito que no modifica el precio de compra.
- Pedir solo el host imprescindible. Si se amplia el patron de hosts, la
  revision se alarga.
