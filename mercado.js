// Carga y lectura de la base de mercado automotriz (año, mes, marca, modelo, segmento, precio, cantidad).

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
const sinTilde = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// Nombres de columna aceptados (sin tildes, minúsculas)
const ALIAS = {
  anio: ["anio", "ano", "year", "periodo_anio"],
  mes: ["mes", "month"],
  marca: ["marca", "brand", "make"],
  modelo: ["modelo", "model"],
  combustible: ["combustible", "propulsion", "fuel", "motorizacion", "tipo_combustible"],
  segmento: ["segmento", "segment", "tipo", "carroceria"],
  precio: ["precio", "price", "pvp", "precio_promedio"],
  ventas: ["cantidad", "ventas", "venta", "unidades", "units", "matriculados", "volumen"],
};

// Lector CSV (comas o punto y coma, comillas dobles, saltos de línea dentro de comillas)
export function leerCsv(texto) {
  let t = String(texto ?? "").replace(/^﻿/, "");
  const primera = t.split(/\r?\n/, 1)[0] || "";
  const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ";" : (primera.includes("\t") ? "\t" : ",");
  const filas = [];
  let fila = [], cel = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cel += '"'; i++; } else q = false; }
      else cel += c;
    } else if (c === '"') q = true;
    else if (c === sep) { fila.push(cel); cel = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      fila.push(cel); cel = "";
      if (fila.some((x) => x.trim() !== "")) filas.push(fila);
      fila = [];
    } else cel += c;
  }
  fila.push(cel);
  if (fila.some((x) => x.trim() !== "")) filas.push(fila);
  return filas;
}

// "1.234,50" (Ecuador/Europa) o "1,234.50" (EE.UU.) o "$ 25 990" -> número
export function numero(v) {
  let s = String(v ?? "").replace(/[$\s ]/g, "");
  if (s === "") return null;
  const coma = s.lastIndexOf(","), punto = s.lastIndexOf(".");
  if (coma >= 0 && punto >= 0) s = coma > punto ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (coma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  else if (punto >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function procesarCsv(texto, { marcasPropias = [] } = {}) {
  const filas = leerCsv(texto);
  if (filas.length < 2) return { error: "El archivo no tiene datos (necesita encabezado y al menos una fila)." };
  const enc = filas[0].map(sinTilde);
  const col = {};
  for (const [k, alias] of Object.entries(ALIAS)) col[k] = enc.findIndex((h) => alias.includes(h));
  const faltan = ["anio", "mes", "marca", "modelo", "ventas"].filter((k) => col[k] < 0);
  if (faltan.length)
    return { error: `Faltan columnas: ${faltan.join(", ")}. Encabezado esperado: anio, mes, marca, modelo, segmento, precio, cantidad. Encontré: ${filas[0].join(" | ")}` };

  const propias = new Set(marcasPropias.map(sinTilde));
  const ok = [], errores = [];
  let nErr = 0;
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i], n = i + 1;
    const g = (k) => (col[k] >= 0 ? String(f[col[k]] ?? "").trim() : "");
    const anio = Number(g("anio"));
    let mes = Number(g("mes"));
    if (!Number.isInteger(mes)) mes = MESES[sinTilde(g("mes"))];
    const marca = g("marca"), modelo = g("modelo");
    const ventas = numero(g("ventas"));
    const precio = g("precio") === "" ? null : numero(g("precio"));
    let e = null;
    if (!Number.isInteger(anio) || anio < 1990 || anio > 2100) e = "año inválido";
    else if (!Number.isInteger(mes) || mes < 1 || mes > 12) e = "mes inválido";
    else if (!marca || !modelo) e = "falta marca o modelo";
    else if (ventas === null || Number.isNaN(ventas) || ventas < 0) e = "cantidad inválida";
    else if (Number.isNaN(precio) || (precio !== null && precio < 0)) e = "precio inválido";
    if (e) { if (errores.length < 15) errores.push(`Fila ${n}: ${e}`); nErr++; continue; }
    ok.push({ anio, mes, marca: marca.slice(0, 60), modelo: modelo.slice(0, 80), segmento: g("segmento").slice(0, 60) || null, combustible: g("combustible").slice(0, 40) || null,
      ventas: Math.round(ventas), precio, propia: propias.has(sinTilde(marca)) });
  }
  const periodos = [...new Set(ok.map((r) => r.anio * 100 + r.mes))].sort();
  return { filas: ok, errores, totalErrores: nErr, periodos, leidas: filas.length - 1 };
}

// ---------------------------------------------------------------------------
// Texto de mercado para el prompt (compacto): lo que el asesor puede usar al hablar con el cliente.
// ---------------------------------------------------------------------------
// global primero, la empresa pisa al mismo marca/modelo/mes/combustible
function unificar(filas) {
  const m = new Map();
  for (const r of [...filas].sort((a, b) => (a.empresa_id ? 1 : 0) - (b.empresa_id ? 1 : 0)))
    m.set(`${r.anio}|${r.mes}|${sinTilde(r.marca)}|${sinTilde(r.modelo)}|${sinTilde(r.combustible)}`, r);
  return [...m.values()].map((r) => ({ ...r, p: r.anio * 100 + r.mes, ventas: Number(r.ventas) || 0, precio: r.precio == null ? null : Number(r.precio) }));
}
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "s/d");
const mm = (p) => `${String(p).slice(0, 4)}-${String(p).slice(4)}`;
const nf = (n) => Number(n).toLocaleString("es-EC");

export function textoMercado(filas, marcasPropias = []) {
  if (!filas?.length) return "";
  const propias = new Set(marcasPropias.map(sinTilde));
  const datos = unificar(filas);
  const periodos = [...new Set(datos.map((d) => d.p))].sort();
  const ult = periodos[periodos.length - 1];
  // ventana: últimos 3 meses disponibles
  const ventana = periodos.slice(-3);
  const w = datos.filter((d) => ventana.includes(d.p));
  const total = w.reduce((s, d) => s + d.ventas, 0);
  if (!total) return "";
  // mismos meses del año anterior
  const prev = ventana.map((p) => p - 100);
  const totalPrev = datos.filter((d) => prev.includes(d.p)).reduce((s, d) => s + d.ventas, 0);

  const porMes = new Map();
  for (const d of datos) porMes.set(d.p, (porMes.get(d.p) || 0) + d.ventas);
  const L = [`\n## MERCADO AUTOMOTRIZ (datos cargados por el administrador)`];
  L.push(`Meses con datos: ${periodos.length} (entre ${mm(periodos[0])} a ${mm(ult)}). El último mes disponible es ${mm(ult)}. Si te preguntan cuántos meses o qué períodos hay, responde con ESTA línea; los análisis de abajo usan solo los últimos 3 meses (${mm(ventana[0])} a ${mm(ult)}) para mantener el texto corto.`);
  L.push("Unidades totales por mes: " + periodos.map((p) => `${mm(p)} ${nf(porMes.get(p))}`).join("; ") + ".");
  const anioUlt = Math.floor(ult / 100), mesUlt = ult % 100;
  const acum = (a) => datos.filter((d) => d.anio === a && d.mes <= mesUlt).reduce((s, d) => s + d.ventas, 0);
  const mesesAnt = new Set(datos.filter((d) => d.anio === anioUlt - 1 && d.mes <= mesUlt).map((d) => d.mes)).size;
  if (mesesAnt === mesUlt) L.push(`Acumulado enero-${mm(ult).slice(5)} ${anioUlt}: ${nf(acum(anioUlt))} u. vs ${nf(acum(anioUlt - 1))} u. en ${anioUlt - 1} (${((acum(anioUlt) / acum(anioUlt - 1) - 1) * 100).toFixed(0)}%).`);
  else L.push(`Acumulado ${anioUlt} (meses cargados): ${nf(acum(anioUlt))} u.`);
  L.push(`Mercado total en la ventana de 3 meses: ${nf(total)} unidades` + (totalPrev ? ` (${((total / totalPrev - 1) * 100).toFixed(0)}% vs mismos meses del año anterior)` : "") + ".");

  const suma = (arr, key) => { const o = new Map(); for (const d of arr) { const k = key(d); o.set(k, (o.get(k) || 0) + d.ventas); } return [...o.entries()].sort((a, b) => b[1] - a[1]); };
  const segs = suma(w, (d) => d.segmento || "Sin segmento");
  L.push("Segmentos (participación): " + segs.slice(0, 6).map(([s, v]) => `${s} ${pct(v, total)}`).join("; ") + ".");

  const comb = suma(w.filter((d) => d.combustible), (d) => d.combustible);
  if (comb.length) {
    const totComb = comb.reduce((s, [, v]) => s + v, 0);
    const prevComb = new Map();
    for (const d of datos) if (prev.includes(d.p) && d.combustible) prevComb.set(d.combustible, (prevComb.get(d.combustible) || 0) + d.ventas);
    L.push("Por combustible/propulsión: " + comb.slice(0, 7).map(([c, v]) => `${c} ${pct(v, totComb)}` + (prevComb.get(c) ? ` (${((v / prevComb.get(c) - 1) * 100).toFixed(0)}% vs año anterior)` : "")).join("; ") + ".");
  }

  const marcas = suma(w, (d) => d.marca);
  const nModelos = new Set(w.filter((d) => d.ventas > 0).map((d) => d.marca + "|" + d.modelo)).size;
  L.push(`Marcas con ventas en la ventana: ${marcas.filter(([, v]) => v > 0).length}; modelos con ventas: ${nModelos}. (Para otros períodos o desgloses, usa la herramienta.)`);
  const propiasLista = marcas.filter(([mk]) => propias.has(sinTilde(mk)));
  if (propiasLista.length) {
    L.push("Marcas de la empresa: " + propiasLista.map(([mk, v]) => {
      const pos = marcas.findIndex(([x]) => x === mk) + 1;
      const antes = datos.filter((d) => prev.includes(d.p) && sinTilde(d.marca) === sinTilde(mk)).reduce((s, d) => s + d.ventas, 0);
      return `${mk} ${nf(v)} u. (${pct(v, total)}, puesto ${pos}` + (antes ? `, ${((v / antes - 1) * 100).toFixed(0)}% vs año anterior` : "") + ")";
    }).join("; ") + ".");
  }
  L.push("Marcas líderes: " + marcas.slice(0, 5).map(([mk, v]) => `${mk} ${pct(v, total)}`).join("; ") + ".");

  // Modelos propios vs. líderes de su segmento
  const modelos = suma(w, (d) => `${d.segmento || "Sin segmento"}|${d.marca}|${d.modelo}`);
  const combDe = (marca, modelo) => { const s = [...new Set(w.filter((d) => d.marca === marca && d.modelo === modelo && d.combustible).map((d) => d.combustible))]; return s.length ? s.join("/") : ""; };
  const precioDe = (marca, modelo) => { const xs = w.filter((d) => d.marca === marca && d.modelo === modelo && d.precio != null); return xs.length ? Math.round(xs.reduce((s, d) => s + d.precio, 0) / xs.length) : null; };
  const lineas = [];
  for (const [seg, vseg] of segs.slice(0, 8)) {
    const delSeg = modelos.filter(([k]) => k.split("|")[0] === seg);
    const mios = delSeg.map(([k, v], i) => ({ k: k.split("|"), v, pos: i + 1 })).filter((x) => propias.has(sinTilde(x.k[1]))).slice(0, 3);
    if (!mios.length) continue;
    const lideres = delSeg.slice(0, 3).map(([k, v]) => { const [, mk, md] = k.split("|"); const pr = precioDe(mk, md); return `${mk} ${md} ${nf(v)} u.${pr ? ` (~$${nf(pr)})` : ""}`; });
    lineas.push(`- ${seg} (${nf(vseg)} u.): líderes ${lideres.join(", ")}. Nuestros: ` +
      mios.map((x) => { const pr = precioDe(x.k[1], x.k[2]); return `${x.k[1]} ${x.k[2]}${combDe(x.k[1], x.k[2]) ? " [" + combDe(x.k[1], x.k[2]) + "]" : ""} puesto ${x.pos} de ${delSeg.length}, ${nf(x.v)} u.${pr ? ` (~$${nf(pr)})` : ""}`; }).join("; "));
  }
  if (lineas.length) { L.push("Nuestros modelos frente a su segmento:"); L.push(...lineas); }
  const vals = (k) => [...new Set(datos.map((d) => d[k]).filter(Boolean))].sort();
  L.push(`Valores exactos en la base para filtrar -> segmentos: ${vals("segmento").join(", ")}; combustibles: ${vals("combustible").join(", ") || "s/d"}.`);
  L.push("Para listas, precios o ventas de modelos concretos (ej. 'SUV eléctricas con precio', 'los 10 más vendidos', 'precio del Tracker') USA la herramienta consultar_mercado antes de responder. No digas que no tienes el dato sin consultarla.");
  L.push("Uso: apóyate en estas cifras solo como argumento de mercado (ej. 'es de los más vendidos de su segmento'); no las cites como si fueran de la marca ni inventes cifras que no estén aquí.");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Herramienta que el agente puede llamar para consultar la base completa.
// ---------------------------------------------------------------------------
export const TOOL_MERCADO = {
  name: "consultar_mercado",
  description:
    "Consulta la base de mercado automotriz cargada (ventas y precios por marca, modelo, combustible y segmento). " +
    "Úsala para listas y rankings (ej. SUV eléctricos con precio, top de ventas de un segmento, ventas y precio de un modelo). " +
    "Devuelve unidades vendidas en el período y precio promedio. Usa los valores exactos de segmento y combustible indicados en el contexto.",
  input_schema: {
    type: "object",
    properties: {
      segmento: { type: "string", description: "Ej. SUV, AUTOMOVIL, PICK UP, VAN, CAMION (valores del contexto). Vacío = todos." },
      combustible: { type: "string", description: "Ej. ELECTRICO, HIBRIDO, GASOLINA, DIESEL (valores del contexto). Vacío = todos." },
      marca: { type: "string", description: "Filtra por marca (coincidencia parcial)." },
      modelo: { type: "string", description: "Filtra por modelo (coincidencia parcial)." },
      desde: { type: "string", description: "Mes inicial AAAA-MM. Por defecto, hace 3 meses del último dato." },
      hasta: { type: "string", description: "Mes final AAAA-MM. Por defecto, el último mes con datos." },
      agrupar_por: { type: "string", enum: ["modelo", "marca", "segmento", "combustible"], description: "Cómo agrupar los resultados. 'marca' para rankings de marcas o CONTAR marcas (coincidencias = número de marcas); 'segmento' o 'combustible' para participaciones; 'modelo' (por defecto) para listas de modelos." },
      orden: { type: "string", enum: ["unidades", "precio_asc", "precio_desc"], description: "Orden de resultados. Por defecto unidades (más vendidos primero)." },
      limite: { type: "integer", description: "Máximo de filas (1 a 40). Por defecto 20." },
    },
  },
};

export function consultarMercado(filas, a = {}) {
  const datos = unificar(filas || []);
  if (!datos.length) return { error: "No hay datos de mercado cargados." };
  const periodos = [...new Set(datos.map((d) => d.p))].sort();
  const ult = periodos[periodos.length - 1];
  const aP = (s) => { const x = /^(\d{4})-(\d{1,2})$/.exec(String(s || "").trim()); return x ? Number(x[1]) * 100 + Number(x[2]) : null; };
  const hasta = aP(a.hasta) ?? ult;
  const desde = aP(a.desde) ?? periodos[Math.max(periodos.indexOf(ult) - 2, 0)];
  const cont = (campo, q) => !q || sinTilde(campo).includes(sinTilde(q));
  const sel = datos.filter((d) => d.p >= desde && d.p <= hasta && cont(d.segmento, a.segmento) && cont(d.combustible, a.combustible) && cont(d.marca, a.marca) && cont(d.modelo, a.modelo));
  const por = ["marca", "segmento", "combustible"].includes(a.agrupar_por) ? a.agrupar_por : "modelo";
  const g = new Map();
  for (const d of sel) {
    const k = por === "modelo" ? [d.marca, d.modelo, d.combustible || "", d.segmento || ""].join("|") : sinTilde(d[por] || "sin dato");
    const x = g.get(k) || (por === "modelo"
      ? { marca: d.marca, modelo: d.modelo, combustible: d.combustible || null, segmento: d.segmento || null, unidades: 0, _pv: 0, _pu: 0, _ps: 0, _pn: 0 }
      : { [por]: d[por] || "Sin dato", unidades: 0, _pv: 0, _pu: 0, _ps: 0, _pn: 0 });
    x.unidades += d.ventas;
    if (d.precio != null) { x._pv += d.precio * Math.max(d.ventas, 1); x._pu += Math.max(d.ventas, 1); x._ps += d.precio; x._pn++; }
    g.set(k, x);
  }
  const totalU = [...g.values()].reduce((s, x) => s + x.unidades, 0);
  let out = [...g.values()].map((x) => {
    const base = por === "modelo" ? { marca: x.marca, modelo: x.modelo, combustible: x.combustible, segmento: x.segmento } : { [por]: x[por] };
    return { ...base, unidades: x.unidades, participacion_pct: totalU ? Number(((x.unidades / totalU) * 100).toFixed(1)) : 0, precio_promedio: x._pu ? Math.round(x._pv / x._pu) : null };
  });
  const conVentas = out.filter((x) => x.unidades > 0).length;
  if (a.orden === "precio_asc") out.sort((p, q) => (p.precio_promedio ?? Infinity) - (q.precio_promedio ?? Infinity));
  else if (a.orden === "precio_desc") out.sort((p, q) => (q.precio_promedio ?? -1) - (p.precio_promedio ?? -1));
  else out.sort((p, q) => q.unidades - p.unidades);
  const lim = Math.min(Math.max(parseInt(a.limite, 10) || 20, 1), 40);
  return {
    periodo: `${mm(desde)} a ${mm(hasta)}`,
    agrupado_por: por,
    coincidencias: out.length,
    con_ventas: conVentas,
    unidades_total: out.reduce((s, x) => s + x.unidades, 0),
    resultados: out.slice(0, lim),
    nota: out.length ? (por === "modelo" ? "Cada fila es un modelo+combustible; para contar o rankear MARCAS usa agrupar_por='marca'. " : "") + "Precio = promedio ponderado por unidades en el período; es dato de mercado, no precio de lista de la empresa." : "Sin coincidencias: revisa los filtros (usa los valores exactos del contexto).",
  };
}
