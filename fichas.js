// Fichas técnicas: herramientas del copiloto para especificaciones, equipamiento, rendimiento y comparativos.
// Los datos viven en la tabla global fichas_tecnicas (migración 09). Todo se consulta en memoria.
// Regla comercial: en cualquier comparativo se destaca (con datos reales) a las marcas que representa la empresa.

const sinTilde = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const norm = (s) => sinTilde(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const compacto = (s) => norm(s).replace(/ /g, "");
const ALIAS = [[/\bL ?200\b/g, "TRITON"], [/\bD ?MAX\b/g, "D MAX"], [/\bX ?TRAIL\b/g, "X TRAIL"]];
const alias = (s) => ALIAS.reduce((t, [re, to]) => t.replace(re, to), norm(s));
// Una marca es de la empresa si coincide exacta o si empieza por ella ("UD" cubre "UD Trucks").
const esPropia = (set, marca) => {
  const m = norm(marca);
  if (set.has(m)) return true;
  for (const p of set) if (p && m.startsWith(p + " ")) return true;
  return false;
};
const toks = (s) => alias(s).split(" ").filter(Boolean);
const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function cargarFichas(admin) {
  const filas = [];
  for (let d = 0; d < 5000; d += 1000) {
    const { data, error } = await admin.from("fichas_tecnicas").select("*").order("id").range(d, d + 999);
    if (error) return []; // migración 09 aún no ejecutada: el copiloto sigue sin fichas
    filas.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return filas;
}

// Precio promedio de mercado por modelo (últimos 12 meses) para ordenar rivales por cercanía de precio.
export function preciosMercado(filasMercado = []) {
  const acc = new Map();
  for (const f of filasMercado) {
    if (!f.precio || !f.ventas) continue;
    const k = compacto(f.marca) + "|" + compacto(f.modelo);
    const a = acc.get(k) || { v: 0, vp: 0, marca: norm(f.marca), modelo: norm(f.modelo) };
    a.v += f.ventas; a.vp += f.ventas * f.precio;
    acc.set(k, a);
  }
  return [...acc.values()].map((a) => ({ marca: a.marca, modelo: a.modelo, unidades: a.v, precio: Math.round(a.vp / a.v) }));
}
function precioDe(ficha, precios) {
  if (ficha.precio_web) return { usd: Number(ficha.precio_web), fuente: "ficha" };
  const mc = norm(ficha.marca);
  const base = ficha.base_mercado ? compacto(ficha.base_mercado) : null;
  const mod = compacto(ficha.modelo);
  const hit =
    precios.find((p) => base && compacto(p.modelo) === base) ||
    precios.find((p) => p.marca === mc && (compacto(p.modelo).includes(mod) || mod.includes(compacto(p.modelo).replace(/\(.*$/, ""))));
  return hit ? { usd: hit.precio, fuente: "promedio de mercado", unidades: hit.unidades } : null;
}

// ---------------------------------------------------------------------------
// Resolución de "marca modelo versión" -> fichas
// ---------------------------------------------------------------------------
function puntaje(ficha, q) {
  const texto = norm([ficha.marca, ficha.modelo, ficha.version, ficha.base_mercado].filter(Boolean).join(" "));
  const tc = compacto(texto);
  const ts = toks(q);
  if (!ts.length) return 0;
  let hit = 0;
  for (const t of ts) if (texto.split(" ").includes(t) || (t.length > 2 && tc.includes(t))) hit++;
  const cq = compacto(alias(q));
  return hit / ts.length + (tc.includes(cq) ? 0.5 : 0);
}
export function resolver(fichas, consulta, { segmento } = {}) {
  const seg = segmento ? norm(segmento) : null;
  const pool = seg ? fichas.filter((f) => norm(f.segmento) === seg) : fichas;
  const pts = pool.map((f) => [puntaje(f, consulta), f]).filter(([p]) => p >= 0.99);
  if (!pts.length) return [];
  const mejor = Math.max(...pts.map(([p]) => p));
  return pts.filter(([p]) => p >= mejor - 0.01).map(([, f]) => f);
}

// ---------------------------------------------------------------------------
// Presentación compacta de una ficha
// ---------------------------------------------------------------------------
const CAMPOS = [
  ["propulsion", "propulsión"], ["cc", "cilindrada_cc"], ["hp", "potencia_hp"], ["hp_rpm", "hp_a_rpm"],
  ["torque_nm", "torque_nm"], ["torque_rpm", "torque_a_rpm"], ["bateria_kwh", "bateria_kwh"], ["autonomia_km", "autonomia_km"],
  ["transmision", "transmision"], ["traccion", "traccion"], ["largo_mm", "largo_mm"], ["ancho_mm", "ancho_mm"],
  ["alto_mm", "alto_mm"], ["wb_mm", "distancia_ejes_mm"], ["maletero_l", "maletero_l"], ["maletero_max_l", "maletero_max_l"],
  ["despeje_mm", "despeje_mm"], ["peso_vacio_kg", "peso_vacio_kg"], ["pbv_kg", "pbv_kg"], ["carga_kg", "carga_util_kg"],
  ["arrastre_kg", "arrastre_kg"], ["tanque_l", "tanque_l"], ["pasajeros", "pasajeros"], ["airbags", "airbags"],
  ["adas", "adas_asistencias"], ["aros", "aros"], ["garantia", "garantia"],
];
function vista(f, precios, propias, completa = true) {
  const o = {
    marca: f.marca, modelo: f.modelo, version: f.version || undefined, segmento: f.segmento,
    marca_de_la_empresa: esPropia(propias, f.marca),
    confianza: f.confianza, fuente: f.fuente, fecha_documento: f.fecha_doc || undefined,
  };
  const p = precioDe(f, precios);
  if (p) o.precio_referencia = p;
  for (const [k, lbl] of CAMPOS) {
    if (!completa && !["potencia_hp", "torque_nm", "transmision", "traccion", "autonomia_km"].includes(lbl) && lbl !== "propulsión") continue;
    if (f[k] !== null && f[k] !== undefined && f[k] !== "") o[lbl] = typeof f[k] === "string" && /^\d+(\.\d+)?$/.test(f[k]) ? Number(f[k]) : f[k];
  }
  if (completa && f.notas) o.notas = f.notas;
  if (completa && f.extra && Object.keys(f.extra).length) o.otros = f.extra;
  return o;
}

// ---------------------------------------------------------------------------
// Métricas para comparar (mayor es mejor)
// ---------------------------------------------------------------------------
const anios = (g) => {
  const m = String(g ?? "").match(/(\d+)\s*(años|año)/i);
  return m ? Number(m[1]) : null;
};
const METRICAS = [
  ["potencia", "Potencia (hp)", (f) => n(f.hp), "hp"],
  ["torque", "Torque (Nm)", (f) => n(f.torque_nm), "Nm"],
  ["autonomia", "Autonomía eléctrica/declarada (km)", (f) => n(f.autonomia_km), "km"],
  ["bateria", "Batería (kWh)", (f) => n(f.bateria_kwh), "kWh"],
  ["maletero", "Maletero (L)", (f) => n(f.maletero_l), "L"],
  ["espacio", "Distancia entre ejes (mm)", (f) => n(f.wb_mm), "mm"],
  ["despeje", "Despeje al suelo (mm)", (f) => n(f.despeje_mm), "mm"],
  ["seguridad", "Airbags", (f) => n(f.airbags), ""],
  ["pasajeros", "Pasajeros", (f) => n(f.pasajeros), ""],
  ["carga", "Carga útil (kg)", (f) => n(f.carga_kg), "kg"],
  ["arrastre", "Arrastre (kg)", (f) => n(f.arrastre_kg), "kg"],
  ["garantia", "Garantía (años)", (f) => anios(f.garantia), "años"],
];

export function comparar(fichasElegidas, precios, propias) {
  const filas = fichasElegidas.map((f) => ({ f, propia: esPropia(propias, f.marca) }));
  const tabla = [];
  const ventajas = []; // donde un modelo de la empresa lidera o empata
  const a_preparar = []; // donde un rival lidera: el asesor debe estar listo
  const sin_dato = [];
  for (const [id, label, get, unidad] of METRICAS) {
    const vals = filas.map(({ f }) => get(f));
    const con = vals.filter((v) => v !== null && v !== undefined);
    if (con.length < 2) {
      if (con.length === 1) sin_dato.push(`${label}: solo hay dato de ${filas[vals.findIndex((v) => v != null)].f.modelo}; no se puede comparar`);
      continue;
    }
    const max = Math.max(...con);
    const fila = { metrica: label, valores: filas.map(({ f }, i) => ({ modelo: `${f.marca} ${f.modelo}`, valor: vals[i] ?? "s/d" })) };
    fila.lider = filas.filter((_, i) => vals[i] === max).map(({ f }) => `${f.marca} ${f.modelo}`);
    tabla.push(fila);
    const propiasConDato = filas.map((x, i) => ({ ...x, v: vals[i] })).filter((x) => x.propia && x.v != null);
    const rivalesConDato = filas.map((x, i) => ({ ...x, v: vals[i] })).filter((x) => !x.propia && x.v != null);
    if (propiasConDato.length && rivalesConDato.length) {
      const mp = Math.max(...propiasConDato.map((x) => x.v));
      const mr = Math.max(...rivalesConDato.map((x) => x.v));
      const lp = propiasConDato.find((x) => x.v === mp).f;
      const lr = rivalesConDato.find((x) => x.v === mr).f;
      const pct = mr ? Math.round(((mp - mr) / mr) * 100) : 0;
      if (mp >= mr) ventajas.push(`${label}: ${lp.marca} ${lp.modelo} ${mp} ${unidad} ${mp === mr ? "(empata con" : "frente a"} ${lr.marca} ${lr.modelo} ${mr} ${unidad}${mp === mr ? ")" : ` (+${pct}%)`}`);
      else a_preparar.push(`${label}: ${lr.marca} ${lr.modelo} ${mr} ${unidad} supera a ${lp.marca} ${lp.modelo} ${mp} ${unidad} (${pct}%)`);
    }
  }
  // Equipamiento cualitativo y confianza de datos
  const notas = [];
  for (const { f } of filas) {
    if (f.confianza !== "Alta") notas.push(`${f.marca} ${f.modelo}: confianza ${f.confianza} (${f.fuente || "fuente s/d"}); presenta el dato como "por confirmar".`);
    if (f.notas) notas.push(`${f.marca} ${f.modelo}: ${f.notas}`);
  }
  const precio = filas.map(({ f }) => ({ modelo: `${f.marca} ${f.modelo}`, precio: precioDe(f, precios) }));
  return { tabla, ventajas_de_la_empresa: ventajas, puntos_donde_el_rival_supera: a_preparar, datos_no_comparables: sin_dato, precios: precio, avisos: notas };
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------
export const TOOL_FICHAS = {
  name: "buscar_fichas",
  description:
    "Busca fichas técnicas oficiales (especificaciones, equipamiento, rendimiento, dimensiones, seguridad, garantía) de un modelo o de un grupo de modelos. " +
    "Úsala para cualquier pregunta técnica ('qué potencia tiene', 'cuánto carga', 'qué airbags trae', 'qué autonomía') o para listar opciones por segmento/propulsión/rango. " +
    "Devuelve cada dato con su fuente, fecha y nivel de confianza. Un dato ausente significa que la ficha no lo dice: nunca lo inventes.",
  input_schema: {
    type: "object",
    properties: {
      consulta: { type: "string", description: "Marca y/o modelo y/o versión en texto libre, ej. 'Tunland V9', 'Hilux 4x4', 'Seltos'. Vacío para listar por filtros." },
      segmento: { type: "string", enum: ["SUV", "Auto", "Pickup", "Van", "Camión", "Bus"], description: "Filtra por segmento (camioneta = Pickup; sedán/hatchback = Auto)." },
      propulsion: { type: "string", description: "Filtro parcial: eléctrico, híbrido, PHEV, diésel, gasolina." },
      marca: { type: "string", description: "Filtra por marca (parcial)." },
      solo_marcas_empresa: { type: "boolean", description: "true = solo modelos de las marcas que representa la empresa del asesor." },
      detalle: { type: "string", enum: ["completo", "resumen"], description: "completo (por defecto) para pocos modelos; resumen para listas largas." },
      limite: { type: "integer", description: "Máximo de fichas (1 a 15). Por defecto 6." },
    },
  },
};

export const TOOL_COMPARAR = {
  name: "comparar_modelos",
  description:
    "Compara 2 a 4 modelos lado a lado con fichas oficiales. Calcula en qué métricas lidera cada uno y SEPARA las ventajas de los modelos de la empresa del asesor " +
    "('ventajas_de_la_empresa') de los puntos donde el rival supera ('puntos_donde_el_rival_supera'). " +
    "Úsala siempre que el cliente compare, dude entre marcas o pregunte '¿es mejor X que Y?'. Incluye siempre al menos un modelo de la empresa cuando exista uno comparable.",
  input_schema: {
    type: "object",
    properties: {
      modelos: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" }, description: "Ej. ['Foton Tunland V9', 'Toyota Hilux 4x4', 'Mitsubishi L200']. Puede incluir la versión." },
      segmento: { type: "string", enum: ["SUV", "Auto", "Pickup", "Van", "Camión", "Bus"], description: "Opcional: ayuda a desambiguar nombres." },
    },
    required: ["modelos"],
  },
};

export const TOOL_RIVALES = {
  name: "rivales_de",
  description:
    "Dado un modelo, devuelve sus rivales directos con ficha (mismo segmento, propulsión y rango de precio parecidos) ordenados por cercanía. " +
    "Si el modelo es de otra marca, devuelve además los modelos de la empresa del asesor que mejor compiten con él, para ofrecerlos como alternativa. " +
    "Úsala cuando el cliente nombra un modelo de la competencia o cuando el asesor pregunta contra quién compite un producto.",
  input_schema: {
    type: "object",
    properties: {
      modelo: { type: "string", description: "Marca y modelo, ej. 'Hilux', 'Toyota Hilux', 'Tucson'." },
      limite: { type: "integer", description: "Máximo de rivales (1 a 8). Por defecto 5." },
    },
    required: ["modelo"],
  },
};

export const TOOLS_FICHAS = [TOOL_FICHAS, TOOL_COMPARAR, TOOL_RIVALES];
export const NOMBRES_FICHAS = new Set(TOOLS_FICHAS.map((t) => t.name));

const AGRUPAR = (lista) => {
  const m = new Map();
  for (const f of lista) {
    const k = norm(f.marca + " " + f.modelo);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
  }
  return [...m.values()];
};
const mejorVersion = (vs) => [...vs].sort((a, b) => (n(b.hp) ?? 0) - (n(a.hp) ?? 0) || (n(b.airbags) ?? 0) - (n(a.airbags) ?? 0))[0];
const REGLA =
  "Si hay modelos de la empresa, preséntalos primero y apóyate en 'ventajas_de_la_empresa'. Usa SOLO datos de esta respuesta. " +
  "Donde el rival supere, no lo ocultes ni lo niegues: reencuádralo con un punto fuerte real nuestro (equipamiento, garantía, precio, promoción vigente, servicio). Nunca hables mal del rival.";

async function registrarFaltante(admin, empresaId, consulta) {
  try {
    const c = norm(consulta).toLowerCase();
    if (!c) return;
    const { data } = await admin.from("fichas_faltantes").select("id,veces").eq("empresa_id", empresaId).eq("consulta", c).maybeSingle();
    if (data) await admin.from("fichas_faltantes").update({ veces: data.veces + 1, ultima: new Date().toISOString() }).eq("id", data.id);
    else await admin.from("fichas_faltantes").insert({ empresa_id: empresaId, consulta: c });
  } catch {
    /* opcional */
  }
}

export async function ejecutarFichas(nombre, a, { fichas, filasMercado, marcasPropias, admin, empresaId }) {
  const propias = new Set((marcasPropias || []).map(norm));
  const precios = preciosMercado(filasMercado);
  a = a || {};

  if (nombre === TOOL_FICHAS.name) {
    let lista = fichas;
    if (a.segmento) lista = lista.filter((f) => norm(f.segmento) === norm(a.segmento));
    if (a.marca) lista = lista.filter((f) => norm(f.marca).includes(norm(a.marca)));
    if (a.propulsion) lista = lista.filter((f) => norm([f.propulsion, f.extra?.emisiones].join(" ")).includes(norm(a.propulsion)));
    if (a.solo_marcas_empresa) lista = lista.filter((f) => esPropia(propias, f.marca));
    if (a.consulta) {
      const r = resolver(lista, a.consulta);
      if (!r.length) {
        registrarFaltante(admin, empresaId, a.consulta);
        return { encontradas: 0, aviso: `No tengo ficha técnica de "${a.consulta}". Dile al asesor que no tienes ese dato y que lo confirme con la ficha oficial; no inventes cifras.` };
      }
      lista = r;
    }
    const lim = Math.min(Math.max(a.limite || 6, 1), 15);
    const total = lista.length;
    lista = [...lista].sort((x, y) => Number(esPropia(propias, y.marca)) - Number(esPropia(propias, x.marca)) || (n(y.hp) ?? 0) - (n(x.hp) ?? 0)).slice(0, lim);
    return { encontradas: total, mostradas: lista.length, fichas: lista.map((f) => vista(f, precios, propias, a.detalle !== "resumen")), regla: REGLA };
  }

  if (nombre === TOOL_COMPARAR.name) {
    const modelos = (a.modelos || []).slice(0, 4);
    const elegidas = [];
    const no_encontrados = [];
    const versiones = {};
    for (const q of modelos) {
      const r = resolver(fichas, q, { segmento: a.segmento });
      if (!r.length) { no_encontrados.push(q); registrarFaltante(admin, empresaId, q); continue; }
      const grupos = AGRUPAR(r);
      const g = grupos[0];
      const f = mejorVersion(g);
      if (!elegidas.includes(f)) {
        elegidas.push(f);
        if (g.length > 1) versiones[`${f.marca} ${f.modelo}`] = `se comparó la versión "${f.version || "base"}" (la de mayor potencia); hay ${g.length} versiones: ${g.map((x) => x.version).filter(Boolean).join(", ")}`;
      }
    }
    if (elegidas.length < 2)
      return { error: "No hay fichas suficientes para comparar.", no_encontrados, aviso: "Dile al asesor qué modelos no tienes en la base y compara solo con datos que sí existan; no inventes." };
    const hayPropia = elegidas.some((f) => esPropia(propias, f.marca));
    const out = {
      modelos: elegidas.map((f) => vista(f, precios, propias, true)),
      comparacion: comparar(elegidas, precios, propias),
      versiones_usadas: versiones,
      no_encontrados,
      regla: REGLA,
    };
    if (!hayPropia)
      out.sugerencia = "Ninguno de los modelos es de la empresa: llama a rivales_de con el modelo principal para proponer una alternativa nuestra y vuelve a comparar.";
    return out;
  }

  if (nombre === TOOL_RIVALES.name) {
    const r = resolver(fichas, a.modelo || "");
    if (!r.length) {
      registrarFaltante(admin, empresaId, a.modelo);
      return { aviso: `No tengo ficha de "${a.modelo}". Pide al asesor la versión/segmento o confirma con la ficha oficial.` };
    }
    const base = mejorVersion(AGRUPAR(r)[0]);
    const pb = precioDe(base, precios)?.usd ?? null;
    const lim = Math.min(Math.max(a.limite || 5, 1), 8);
    const prop = (f) => {
      const p = norm(f.propulsion || "");
      if (/HIBRID|HEV|PHEV|E POWER|EPOWER/.test(p)) return "hib";
      if (p.includes("ELECTR")) return "ev";
      return "ice";
    };
    const cand = fichas
      .filter((f) => f.segmento === base.segmento && norm(f.marca + f.modelo) !== norm(base.marca + base.modelo))
      .map((f) => {
        const p = precioDe(f, precios)?.usd ?? null;
        const dist = pb && p ? Math.abs(p - pb) / pb : 0.6;
        const penal = prop(f) === prop(base) ? 0 : 0.25;
        return { f, p, score: dist + penal };
      });
    const mejorPorModelo = (lista) => AGRUPAR(lista.map((c) => c.f)).map((g) => {
      const f = mejorVersion(g);
      return cand.find((c) => c.f === f);
    }).sort((x, y) => x.score - y.score);
    const propiaBase = esPropia(propias, base.marca);
    const rivales = mejorPorModelo(cand.filter((c) => !esPropia(propias, c.f.marca))).slice(0, lim);
    const nuestras = propiaBase ? [] : mejorPorModelo(cand.filter((c) => esPropia(propias, c.f.marca))).slice(0, 3);
    return {
      modelo_consultado: vista(base, precios, propias, false),
      rivales: rivales.map((c) => vista(c.f, precios, propias, false)),
      alternativas_de_la_empresa: nuestras.map((c) => vista(c.f, precios, propias, false)),
      nota: propiaBase
        ? "Es un modelo de la empresa: usa comparar_modelos con 1 o 2 de estos rivales para armar los argumentos."
        : "Es un modelo de la competencia: ofrece primero la alternativa de la empresa y usa comparar_modelos para sustentarlo.",
      regla: REGLA,
    };
  }
  return { error: "Herramienta desconocida" };
}

// Resumen corto para el contexto (cuántas fichas hay y de qué marcas), para que el agente sepa que existen.
export function textoFichas(fichas, marcasPropias = []) {
  if (!fichas.length) return "";
  const propias = new Set(marcasPropias.map(norm));
  const por = {};
  for (const f of fichas) por[f.segmento] = (por[f.segmento] || 0) + 1;
  const nuestras = [...new Set(fichas.filter((f) => esPropia(propias, f.marca)).map((f) => `${f.marca} ${f.modelo}`))];
  return (
    `\n## FICHAS TÉCNICAS DISPONIBLES (${fichas.length} versiones: ${Object.entries(por).map(([k, v]) => `${k} ${v}`).join(", ")})\n` +
    "Para especificaciones, equipamiento, rendimiento o comparativos usa las herramientas buscar_fichas, comparar_modelos y rivales_de (no respondas cifras técnicas de memoria).\n" +
    (nuestras.length ? `Modelos de nuestra empresa con ficha: ${nuestras.join(", ")}.` : "No hay fichas de modelos de nuestra empresa cargadas todavía.")
  );
}
