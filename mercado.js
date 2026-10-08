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
  else if (coma >= 0) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
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
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "s/d");
const mm = (p) => `${String(p).slice(0, 4)}-${String(p).slice(4)}`;
const nf = (n) => Number(n).toLocaleString("es-EC");

export function textoMercado(filas, marcasPropias = []) {
  if (!filas?.length) return "";
  const propias = new Set(marcasPropias.map(sinTilde));
  // global primero, la empresa pisa al mismo marca/modelo/mes
  const m = new Map();
  for (const r of [...filas].sort((a, b) => (a.empresa_id ? 1 : 0) - (b.empresa_id ? 1 : 0)))
    m.set(`${r.anio}|${r.mes}|${sinTilde(r.marca)}|${sinTilde(r.modelo)}`, r);
  const datos = [...m.values()].map((r) => ({ ...r, p: r.anio * 100 + r.mes, ventas: Number(r.ventas) || 0, precio: r.precio == null ? null : Number(r.precio) }));
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

  const L = [`\n## MERCADO AUTOMOTRIZ (datos cargados por el administrador; último mes disponible ${mm(ult)}; ventana ${mm(ventana[0])} a ${mm(ult)})`];
  L.push(`Mercado total en la ventana: ${nf(total)} unidades` + (totalPrev ? ` (${((total / totalPrev - 1) * 100).toFixed(0)}% vs mismos meses del año anterior)` : "") + ".");

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
  L.push("Uso: apóyate en estas cifras solo como argumento de mercado (ej. 'es de los más vendidos de su segmento'); no las cites como si fueran de la marca ni inventes cifras que no estén aquí.");
  return L.join("\n");
}
