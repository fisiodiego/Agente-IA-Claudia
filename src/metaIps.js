// ─────────────────────────────────────────────────────────────────────────────
// Faixas de IP oficiais da Meta (AS32934), usadas para autenticar a ORIGEM do
// webhook do WhatsApp. Geradas de `whois -h whois.radb.net -- "-i origin AS32934"`
// em 19/ago/2026 e compactadas em intervalos [inicio, fim] de inteiros IPv4.
//
// Contexto: o webhook chega DIRETO da Meta (confirmado: 251 IPs distintos no
// histórico do nginx, 100% dentro destas faixas, 0 fora). Como a WABA é da
// ChakraHQ, não temos o App Secret para validar a assinatura HMAC — a origem
// é a autenticação possível hoje.
//
// FAIL-OPEN por segurança operacional: IP ausente ou irreconhecível ALLOW +
// log. Só rejeita quando dá pra afirmar que o IP está fora da Meta. Assim uma
// mudança de proxy nunca deixa a clínica muda.
// ─────────────────────────────────────────────────────────────────────────────

const RANGES = [
  [520951808,520953855],
  [520962048,520978431],
  [759179264,759180287],
  [965541888,965545983],
  [965545984,965548031],
  [965548032,965548543],
  [965738496,966000639],
  [1121751040,1121755135],
  [1161801728,1161805823],
  [1168891904,1168900095],
  [1249332224,1249333247],
  [1719951360,1719955455],
  [1728339968,1728340991],
  [2173042688,2173108223],
  [2471219200,2471223295],
  [2649751552,2649817087],
  [2739306496,2739339263],
  [2739765248,2739798015],
  [2918989824,2919006207],
  [3007102976,3007103999],
  [3107772416,3107773439],
  [3109672960,3109673983],
  [3423540224,3423541247]
];

function ipv4ToInt(ip) {
  const p = String(ip).trim().split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Extrai o primeiro IP utilizável de X-Real-IP / X-Forwarded-For. */
export function extrairIp(req) {
  const real = req.headers['x-real-ip'];
  const fwd = req.headers['x-forwarded-for'];
  let cand = (real || (fwd ? String(fwd).split(',')[0] : '') || req.ip || '').trim();
  if (cand.startsWith('::ffff:')) cand = cand.slice(7); // IPv4 mapeado em IPv6
  return cand;
}

/**
 * true  = IP comprovadamente da Meta
 * false = IPv4 válido e comprovadamente FORA da Meta (único caso que rejeita)
 * null  = não deu pra determinar (vazio, IPv6, malformado) → fail-open
 */
export function checarOrigemMeta(ip) {
  if (!ip) return null;
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  let lo = 0, hi = RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = RANGES[mid];
    if (n < a) hi = mid - 1;
    else if (n > b) lo = mid + 1;
    else return true;
  }
  return false;
}

export const TOTAL_FAIXAS = RANGES.length;
