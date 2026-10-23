// Ficha comercial de una página para un modelo de la empresa: 6 puntos fuertes verificables frente a sus rivales,
// promoción vigente, precio de referencia, costo de uso y un texto listo para WhatsApp. Todo sale de datos cargados (sin IA).
import { resolver, comparar, preciosMercado, ejecutarFichas, TOOL_RIVALES, esPropia, AGRUPAR, mejorVersion, norm, precioDe } from "./fichas.js";
import { estimar, estadoPrecios, ETIQUETA } from "./costouso.js";

const dinero = (v) => (v == null ? null : "$" + Math.round(v).toLocaleString("en-US"));
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

export function modelosDeLaEmpresa(fichas, marcasPropias) {
  const propias = new Set((marcasPropias || []).map(norm));
  const m = new Map();
  for (const f of fichas) {
    if (!esPropia(propias, f.marca)) continue;
    const k = `${f.marca}|${f.modelo}`;
    if (!m.has(k)) m.set(k, { marca: f.marca, modelo: f.modelo, segmento: f.segmento, versiones: 0 });
    m.get(k).versiones++;
  }
  return [...m.values()].sort((a, b) => a.marca.localeCompare(b.marca) || a.modelo.localeCompare(b.modelo));
}

const coincide = (p, f) => {
  const pm = norm(p.marca), fm = norm(f.marca);
  if (!(pm === fm || fm.startsWith(pm + " ") || pm.startsWith(fm + " "))) return false;
  if (!p.modelo) return true;
  const a = norm(p.modelo).replace(/ /g, ""), b = norm(f.modelo).replace(/ /g, "");
  return a.includes(b) || b.includes(a);
};

export async function fichaComercial(consulta, ctx) {
  const { fichas, filasMercado, marcasPropias, promos, productos, params, empresaNombre } = ctx;
  const propias = new Set((marcasPropias || []).map(norm));
  const precios = preciosMercado(filasMercado || []);
  const r = resolver(fichas, consulta || "");
  if (!r.length) return { error: `No tengo ficha técnica de "${consulta}".` };
  const grupo = AGRUPAR(r)[0];
  const base = mejorVersion(grupo);
  if (!esPropia(propias, base.marca)) {
    const alt = await ejecutarFichas(TOOL_RIVALES.name, { modelo: consulta, limite: 1 }, { ...ctx, admin: null });
    return { error: `${base.marca} ${base.modelo} no es de las marcas de ${empresaNombre}. Esta ficha es solo para tus productos.`, alternativas: (alt.alternativas_de_la_empresa || []).map((x) => `${x.marca} ${x.modelo}`) };
  }

  // Rivales: los 3 más cercanos por segmento/precio/tecnología (misma lógica que rivales_de)
  const rv = await ejecutarFichas(TOOL_RIVALES.name, { modelo: consulta, limite: 3 }, { ...ctx, admin: null });
  const rivales = (rv.rivales || []).map((x) => fichas.find((f) => f.marca === x.marca && f.modelo === x.modelo && (f.version || "") === (x.version || ""))).filter(Boolean);
  const cmp = rivales.length ? comparar([base, ...rivales], precios, propias) : null;

  const puntos = [];
  for (const v of cmp?.ventajas_de_la_empresa || []) if (puntos.length < 4) puntos.push({ tipo: "vs_rivales", texto: v });
  const intr = [];
  if (num(base.airbags)) intr.push(`${base.airbags} airbags${base.adas ? ` y asistencias: ${base.adas}` : ""}`);
  else if (base.adas) intr.push(`Asistencias de seguridad: ${base.adas}`);
  if (base.garantia) intr.push(`Garantía: ${base.garantia}`);
  if (num(base.autonomia_km)) intr.push(`Autonomía declarada ${base.autonomia_km} km (según ciclo de la ficha)`);
  if (num(base.pasajeros) && num(base.maletero_l)) intr.push(`${base.pasajeros} pasajeros y ${base.maletero_l} L de maletero`);
  else if (num(base.carga_kg)) intr.push(`Carga útil ${base.carga_kg} kg`);
  if (base.traccion) intr.push(`Tracción ${base.traccion}`);
  for (const t of intr) if (puntos.length < 5) puntos.push({ tipo: "ficha", texto: t });
  const cu = estimar(base, params);
  let costo_uso = null;
  if (!cu.sin_estimado) {
    costo_uso = { usd_100km: Math.round(cu.usd100 * 10) / 10, metodo: cu.metodo, etiqueta: ETIQUETA };
    if (puntos.length < 6) puntos.push({ tipo: "costo_uso", texto: `Costo de combustible/energía estimado ≈ $${Math.round((cu.usd100 * 15000) / 100 / 12)} al mes (15.000 km/año, estimación por categoría)` });
  }

  const promosAplican = (promos || []).filter((p) => coincide(p, base)).map((p) => ({ titulo: p.titulo, detalle: p.detalle, condiciones: p.condiciones || null, hasta: p.vigente_hasta }));
  const lista = (productos || []).filter((p) => coincide({ marca: p.marca, modelo: p.modelo }, base) && p.precio).map((p) => ({ version: p.version || null, precio: Number(p.precio) }));
  const pref = precioDe(base, precios);
  const versiones = grupo.map((f) => ({ version: f.version || "Única", hp: num(f.hp), torque_nm: num(f.torque_nm), transmision: f.transmision || null, traccion: f.traccion || null, airbags: num(f.airbags) }));

  const avisos = [];
  if (base.confianza !== "Alta") avisos.push(`Algunos datos de esta ficha son de confianza ${base.confianza} (${base.fuente || "fuente s/d"}): confírmalos antes de prometerlos.`);
  const ep = estadoPrecios(params);
  if (costo_uso && !ep.ok) avisos.push(ep.aviso);
  if (!promosAplican.length) avisos.push("No hay promoción vigente cargada para este modelo.");
  if (!lista.length) avisos.push(pref ? `Sin precio de lista cargado: el precio mostrado es ${pref.fuente}.` : "Sin precio de referencia.");

  const titulo = `${base.marca} ${base.modelo}`;
  const precioTxt = lista.length ? `desde ${dinero(Math.min(...lista.map((l) => l.precio)))}` : pref ? `referencia ${dinero(pref.usd)}` : null;
  const wa = [
    `*${titulo}*${precioTxt ? ` — ${precioTxt}` : ""}`,
    ...puntos.slice(0, 4).map((p) => `✅ ${p.texto}`),
    ...(promosAplican[0] ? [`🎁 ${promosAplican[0].titulo} (hasta ${promosAplican[0].hasta})`] : []),
    "¿Agendamos una prueba de manejo esta semana? Dime qué día te queda mejor.",
  ].join("\n");

  return {
    titulo, empresa: empresaNombre, segmento: base.segmento, propulsion: base.propulsion || null,
    precio: { lista, referencia: pref ? { usd: pref.usd, fuente: pref.fuente } : null },
    puntos, versiones, promociones: promosAplican, costo_uso,
    comparado_con: rivales.map((f) => `${f.marca} ${f.modelo}`),
    fuente: { documento: base.fuente || null, fecha: base.fecha_doc || null, confianza: base.confianza },
    whatsapp: wa, avisos,
    pie: "Datos según ficha del fabricante y condiciones vigentes. Precios y promociones sujetos a cambio y a disponibilidad; confirma con tu jefatura antes de comprometerte.",
  };
}
