// ─── Transcrição LOCAL de áudio do WhatsApp — modo SOMBRA (01/10/2026) ───────
// Por que existe: o webhook só trata texto/botão; áudio cai no "// TODO" e some
// em silêncio. De 07/04 a 30/09 foram 137 áudios de 53 pacientes (crescendo:
// 15 em abril, 36 em agosto) — 21% ficaram 3h sem resposta de ninguém. Decisão
// do Dr. Diego: transcrever AQUI no VPS com o whisper.cpp (modelo small), custo
// zero e a voz do paciente nunca sai do servidor.
//
// Esta versão (v2, decisão de 01/10) só MEDE. Com AUDIO_TRANSCRICAO=sombra o
// áudio é baixado, transcrito e registrado na tabela audio_sombra — e mais
// nada: não responde, não entra no buffer/conversations/message_log (rate limit,
// janela de 24h e reengajamento intactos), não vai ao CRM, ao Kanban nem ao
// WhatsApp do Dr. Diego. Falha de qualquer tipo = 1 linha de log + linha na
// tabela. 'on' ainda não existe: é tratado como sombra (1 aviso no log). Os
// dados da sombra calibram os limiares antes de qualquer resposta ao paciente.
// Ausente/off/qualquer outro valor = ignorado como sempre foi.
//
// O que o laboratório de 30/09 mediu e está aplicado aqui:
//  - whisper-cli devolve exit 0 MESMO quando não lê o áudio → sucesso = r.json
//    existir e ser JSON válido, nunca o exit code;
//  - download truncado/corrompido passa pelo opusdec com exit 0 e vira meia
//    frase com confiança BOA → confere o sha256 do webhook antes de transcrever;
//  - VAD (silero) corta silêncio/ruído em ~1s e acaba com a 2ª passada de
//    encode que inventava "[Música]" no fim da fala; greedy (-bs 1 -bo 1) teve
//    a mesma qualidade do beam, mais rápido e com 110 MB a menos;
//  - --prompt de vocabulário NÃO ajudou e -sns inventou "se inscrever no
//    canal" → nenhum dos dois é usado;
//  - 2 transcrições em paralelo terminam juntas no dobro do tempo e da RAM →
//    fila GLOBAL de 1 por vez; nice 19 não afetou o node nem o CRM.
//
// Isolamento (index-cloudapi.js faz process.exit(1) em uncaughtException, e o
// restart zera o takeover): nada aqui lança para fora de receberAudio() /
// transcreverAudio(); todo processo filho tem 'error' tratado e SIGKILL no
// prazo; o diretório temporário é apagado no finally. Se o processo SAI no
// meio (pm2 restart = SIGINT → process.exit(0); crash alheio → exit(1)), o
// finally não roda: um listener de 'exit' — registrado só na 1ª transcrição,
// nunca na subida nem com off — mata o filho em voo e apaga o diretório. Os
// órfãos de SIGKILL/OOM são apagados no 1º áudio da sombra e pelos scripts
// 6_desligar / 7_reverter_codigo / 8_limpar_orfaos.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import db from './database.js';

// ─── Configuração ───────────────────────────────────────────────────────────
const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/whisper.cpp/build/bin/whisper-cli';
const WHISPER_MODELO = process.env.WHISPER_MODEL || '/opt/whisper.cpp/models/ggml-small.bin';
// VAD: o oficial (models/download-vad-model.sh silero-v6.2.0) quando existir;
// até lá, o arquivo "for-tests" do próprio repositório, que foi o usado em
// TODAS as medições do laboratório. Sem nenhum dos dois, roda sem VAD (mais
// lento, e sem -ac, que sem VAD provoca a cauda alucinada).
const VAD_CANDIDATOS = [
  process.env.WHISPER_VAD_MODEL,
  '/opt/whisper.cpp/models/ggml-silero-v6.2.0.bin',
  '/opt/whisper.cpp/models/for-tests-silero-v6.2.0-ggml.bin',
].filter(Boolean);

export const DUR_MAX_S = 180;             // > 3 min: registra 'longo', sem transcrever
const BYTES_MAX = 5 * 1024 * 1024;        // voz do WhatsApp ~2,4 kB/s: 5 MB ≈ 35 min
const FILA_MAX = 6;                       // na fila + rodando; acima disso falha 'fila'
const MEMORIA_MIN = 800 * 1024 * 1024;    // RSS medido do small: 600-780 MB
const PRAZO_DOWNLOAD_MS = 50000;          // metadados 15 s + arquivo 30 s + folga
const PREFIXO_TMP = 'claudia-audio-';

// Dependências trocáveis pela bancada local (sem rede, sem whisper de verdade).
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  spawn,
  existe: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  memoriaLivre: () => os.freemem(),
  tmpdir: () => os.tmpdir(),
  db: () => db,
};

// ─── Chave liga/desliga (AUDIO_TRANSCRICAO=off|sombra) ──────────────────────
// Lida do ARQUIVO .env a cada áudio, e só no ramo de áudio (texto não lê nada):
// o dotenv carrega uma vez só na subida, e ligar/desligar por pm2 restart
// zeraria o takeover, os buffers e as marcas em memória. Lê SÓ o arquivo, nunca
// o process.env (a foto da última subida: apagar a linha não desligaria).
// Linha ausente, comentada, vazia, valor inválido ou .env ilegível = off. Com a
// linha repetida vale a ÚLTIMA, como no dotenv e no monitor.sh.
let ultimoModo = null;
export function modoAudio() {
  let valor = 'off';
  try {
    const arq = process.env.AUDIO_ENV_PATH || path.resolve(process.cwd(), '.env');
    const txt = fs.readFileSync(arq, 'utf8');
    const ms = [...txt.matchAll(/^[ \t]*(?:export[ \t]+)?AUDIO_TRANSCRICAO[ \t]*=[ \t]*["']?([A-Za-z]*)/gm)];
    if (ms.length) valor = ms[ms.length - 1][1];
  } catch { /* .env ilegível → off (fail-safe) */ }
  valor = String(valor || '').trim().toLowerCase();
  const modo = valor === 'on' || valor === 'sombra' ? valor : 'off';
  // A troca fica no log: prova de que ligou (ou desligou) sem restart.
  if (ultimoModo !== null && modo !== ultimoModo) {
    console.log(`🎤 Transcrição de áudio: modo ${ultimoModo.toUpperCase()} → ${modo.toUpperCase()} (lido do .env)`);
  }
  ultimoModo = modo;
  return modo;
}

// ─── Duração de um Ogg/Opus sem decodificar ─────────────────────────────────
// granule (int64 LE) da última página "OggS" menos o pre_skip do OpusHead, em
// 48 kHz. Conferido no laboratório: 9,72 / 27,44 s contra 9,713 / 27,433 do
// opusinfo. Devolve null se não for Ogg/Opus (bytes mágicos no lugar certo).
export function duracaoOggOpus(buf) {
  if (!buf || buf.length < 47) return null;
  if (buf.toString('latin1', 0, 4) !== 'OggS' || buf.toString('latin1', 28, 36) !== 'OpusHead') return null;
  const preSkip = buf.readUInt16LE(28 + 10);
  const i = buf.lastIndexOf(Buffer.from('OggS'));
  if (i < 0 || i + 14 > buf.length) return null;
  const g = Number(buf.readBigInt64LE(i + 6));
  if (!(g > 0)) return null;
  return Math.max(0, (g - preSkip) / 48000);
}

// ─── Avaliação da saída do whisper (confiança + filtro de alucinação) ───────
// Limiares PROVISÓRIOS (2 áudios do Diego + ruído sintético): na sombra o nível
// é só um rótulo; as métricas cruas vão todas para a tabela e a calibração é
// refeita por SQL antes de qualquer 'on'.
const RE_TAGS = /\[[^\]]*\]|\([^)]*\)|♪+|\*[^*]*\*/g;
// Frases que o whisper INVENTA em silêncio/ruído (vistas no laboratório, mais
// as clássicas do small em pt). O segmento descartado vai para a tabela
// (texto_descartado) para conferir falso positivo ("mais vídeos dos exercícios").
const RE_ALUCINACAO = /inscrev[ae]|inscrever|\blike\b|amara\.?org|legendas?\s+(pela|por|:)|obrigad[oa]s?\s+por\s+assistir|mais\s+v[ií]deos|pr[oó]ximo\s+v[ií]deo|sininho|m[ií]dia\s+de\s+v[ií]deo/i;
// Token de PALAVRA: tem letra ou dígito. Pontuação é token próprio no whisper,
// com p baixo mesmo em fala limpa (nos áudios do Diego: '.' e ',' de 0,31 a
// 0,87) — numa resposta de 1 palavra o '.' mandava na média (revisão 01/10).
const RE_PALAVRA = /[\p{L}\p{N}]/u;
const ehEspecial = (t) => String(t?.text || '').startsWith('[_') || (t?.id ?? 0) >= 50257;

// Trecho de FALA em segundos: do 'from' do 1º segmento ao 'to' do último (o
// -ojf traz offsets em ms, já no tempo do arquivo original mesmo com VAD; no
// d1 do Diego: 2080 a 8860 ms num áudio de 9,7 s). null se não vierem.
function trechoFala(segs) {
  const de = segs.map((s) => s.de).filter(Number.isFinite);
  const ate = segs.map((s) => s.ate).filter(Number.isFinite);
  if (!de.length || !ate.length) return null;
  const s = (Math.max(...ate) - Math.min(...de)) / 1000;
  return s > 0 ? s : null;
}

const media = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const arred = (x, n) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(n));

export function avaliar(json, dur = 0) {
  const segs = (json?.transcription || []).map((s) => {
    const toks = (s?.tokens || []).filter((t) => !ehEspecial(t));
    return {
      texto: String(s?.text || ''),
      de: Number(s?.offsets?.from),
      ate: Number(s?.offsets?.to),
      psTodos: toks.map((t) => Number(t?.p) || 0),
      ps: toks.filter((t) => RE_PALAVRA.test(String(t?.text || ''))).map((t) => Number(t?.p) || 0),
    };
  });
  const bruto = segs.map((s) => s.texto).join('').trim();
  const tinhaTag = new RegExp(RE_TAGS.source).test(bruto);
  const bons = segs.filter((s) => !RE_ALUCINACAO.test(s.texto));
  const descartado = segs.filter((s) => RE_ALUCINACAO.test(s.texto)).map((s) => s.texto.trim()).join(' | ');
  let texto = bons.map((s) => s.texto).join('').replace(RE_TAGS, ' ').replace(/\s+/g, ' ').trim();
  // Laço de repetição (frase repetida 3x): fica uma cópia e o nível cai para incerta.
  const frases = texto.split(/(?<=[.!?])\s+/).filter(Boolean);
  const semRepeticao = frases.filter((f, i) => i === 0 || f.toLowerCase() !== frases[i - 1].toLowerCase());
  const tinhaLaco = semRepeticao.length < frases.length - 1;
  if (semRepeticao.length !== frases.length) texto = semRepeticao.join(' ');
  const ps = bons.flatMap((s) => s.ps);
  const p = media(ps) ?? 0;
  const pBruto = media(bons.flatMap((s) => s.psTodos));
  const fracBaixa = ps.length ? ps.filter((x) => x < 0.5).length / ps.length : 1;
  const letras = (texto.match(/\p{L}/gu) || []).length;
  const palavras = (texto.match(/\p{L}+/gu) || []).length;
  const wps = dur > 0 ? palavras / dur : 0;
  const fala = trechoFala(bons);
  const wpsFala = fala ? palavras / fala : null;
  // Nível (rótulo provisório): fracBaixa só pesa com 3+ tokens de palavra (com
  // 1-2 tokens, 1 token ruim já é 50%). Réguas de palavras/s da v1: pelo trecho
  // de FALA quando ele passa de 6 s; pelo ARQUIVO só com p < 0,85; e 15 s+ com
  // < 0,2 palavra/s ("Obrigado." sobrando de fala que o whisper perdeu).
  const fracConta = ps.length >= 3;
  const reguaFala = (lim) => fala != null && fala >= 6 && wpsFala < lim;
  const reguaArquivo = (lim) => dur >= 6 && p < 0.85 && wps < lim;
  let nivel = 'ok';
  if (letras < 2) nivel = 'vazio';
  else if (p < 0.60 || (fracConta && fracBaixa >= 0.40)) nivel = 'baixa';
  else if (reguaFala(0.25) || reguaArquivo(0.25) || (dur >= 15 && wps < 0.2)) nivel = 'baixa';
  else if (p < 0.75 || (fracConta && fracBaixa >= 0.25) || tinhaTag || tinhaLaco || reguaFala(0.6) || reguaArquivo(0.6)) nivel = 'incerta';
  return {
    texto, nivel,
    // sem token de palavra (silêncio cortado pelo VAD): p/frac null, não 0 — não suja a distribuição
    media: ps.length ? arred(p, 3) : null, mediaBruta: arred(pBruto, 3), fracBaixa: ps.length ? arred(fracBaixa, 2) : null, tokens: ps.length,
    palavras, wps: arred(wps, 2), fala: arred(fala, 1), wpsFala: arred(wpsFala, 2),
    descartouAlucinacao: bons.length !== segs.length, descartado: descartado || null, tinhaLaco,
  };
}

// ─── Saída do processo no meio de uma transcrição (revisão 01/10) ───────────
// process.exit() (o SIGINT do pm2 restart e o exit(1) do uncaughtException do
// index-cloudapi.js) pula o finally: sem isto, a.ogg/a.wav do paciente ficavam
// em /tmp por até 30 dias e, no crash, o whisper seguia órfão (pai = 1, sem
// prazo) e ainda gravava o r.json com a transcrição. Os listeners de 'exit'
// rodam SÍNCRONOS dentro do process.exit(): SIGKILL nos filhos em voo (prlimit
// e nice fazem exec → o pid é o do whisper/opusdec) e fs.rmSync nos diretórios.
// Registrado de forma PREGUIÇOSA, só depois do 1º mkdtemp: na subida e com off
// nenhum listener é criado (o replay confere). SIGKILL/OOM do node não dispara
// 'exit': esses órfãos ficam para o limparOrfaos e os scripts.
const emVoo = { dirs: new Set(), filhos: new Set() };
let vigiaSaida = false;
function limparEmVoo() {
  for (const p of emVoo.filhos) { try { p.kill('SIGKILL'); } catch { /* já morreu */ } }
  for (const d of emVoo.dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* nada a fazer na saída */ } }
}
function vigiarSaida() {
  if (vigiaSaida) return;
  vigiaSaida = true;
  process.once('exit', limparEmVoo);
}

// ─── Processo filho com prlimit, nice, prazo e SIGKILL ──────────────────────
// prlimit --core=1: sem core dump com a voz do paciente (apport 2.28.1 ainda
// grava o .crash do opusdec com 0; 1 é valor reservado no kernel e aborta o
// core). prlimit e nice fazem exec → o pid é o do programa e o SIGKILL do
// prazo o atinge. Resolve SEMPRE (nunca rejeita) e só depois do 'close' — a
// próxima tarefa da fila não começa com um whisper ainda vivo. 'error'
// (binário ausente etc.) também resolve: sem listener derrubaria a Claudia.
const SEM_CLOSE = 'sem close apos kill';
function rodar(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stderr = '';
    let morto = false;
    let fim = false;
    let timer = null;
    let p;
    const terminar = (code, signal, erro) => {
      // Sai do registro da saída só quando morreu de fato ('close'/'error'); no
      // "sem close" continua lá e o 'exit' ainda manda o SIGKILL.
      if (p && erro !== SEM_CLOSE) emVoo.filhos.delete(p);
      if (fim) return;
      fim = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stderr: stderr + (erro ? ` ${erro}` : ''), morto, ms: Date.now() - t0 });
    };
    try {
      // detached:false (o padrão, explícito): mesmo grupo de processos do node,
      // o treekill do pm2 também o alcança.
      p = deps.spawn('prlimit', ['--core=1', 'nice', '-n', '19', cmd, ...args], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    } catch (e) {
      return terminar(-1, null, e.message);
    }
    if (p) emVoo.filhos.add(p);
    p.on('error', (e) => terminar(-1, null, e.message));
    p.stderr?.on('error', () => {});
    p.stderr?.on('data', (d) => { if (stderr.length < 8000) stderr += d; });
    timer = setTimeout(() => {
      morto = true;
      try { p.kill('SIGKILL'); } catch { /* já morreu */ }
      // Se nem o 'close' vier em 5s (não deveria), solta a fila mesmo assim.
      timer = setTimeout(() => terminar(null, 'SIGKILL', SEM_CLOSE), 5000);
    }, timeoutMs);
    p.on('close', (code, signal) => terminar(code, signal));
  });
}

// ─── Fila GLOBAL de 1 por vez ───────────────────────────────────────────────
let fila = Promise.resolve();
let naFila = 0;
function enfileirar(tarefa) {
  if (naFila >= FILA_MAX) return Promise.resolve({ ok: false, motivo: 'fila' });
  naFila++;
  const job = fila.then(tarefa).catch((e) => ({ ok: false, motivo: 'erro', detalhe: String(e?.message || e).slice(0, 80) })).finally(() => { naFila--; });
  fila = job.then(() => {}, () => {});
  return job;
}
export const tamanhoFila = () => naFila;

// Promise com prazo: resolve com 'valor' se não vier a tempo (fetch que ignora
// o AbortSignal não pode deixar a linha 'pendente' para sempre).
function comPrazo(promessa, ms, valor) {
  let t = null;
  const prazo = new Promise((ok) => { t = setTimeout(() => ok(valor), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(t));
}

// ─── Download da mídia (Graph API com o token de sistema) ───────────────────
// GET /{media_id} → url → GET url com o MESMO Bearer. O pass-through da
// ChakraHQ devolve 404 e o WA_ACCESS_TOKEN 401 (testado em 30/09). A mídia
// some da Graph em 5-7 dias: baixa-se NA CHEGADA, não há reprocessamento.
// Nunca logar a url nem o token.
async function baixar(mediaId, sha256Webhook) {
  const token = process.env.META_SYSTEM_TOKEN;
  if (!token) return { erro: 'sem_token' };
  if (!/^\d{5,40}$/.test(String(mediaId || ''))) return { erro: 'media_id_invalido' };
  const h = { Authorization: `Bearer ${token}` };
  const r1 = await deps.fetch(`https://graph.facebook.com/v22.0/${mediaId}`, { headers: h, signal: AbortSignal.timeout(15000) });
  if (!r1?.ok) {
    // Token vencido/revogado derruba 100% dos áudios: 401/403, ou 400 com code 190.
    const corpo = await r1?.json?.().catch(() => null);
    if (r1?.status === 401 || r1?.status === 403 || corpo?.error?.code === 190) {
      return { erro: 'token', detalhe: `token_meta_${r1?.status}${corpo?.error?.code ? '_code' + corpo.error.code : ''}` };
    }
    return { erro: `meta_${r1?.status}` };
  }
  const meta = await r1.json().catch(() => null);
  if (!meta?.url) return { erro: 'meta_sem_url' };
  const tamanho = Number(meta.file_size) || 0;
  if (tamanho > BYTES_MAX) return { erro: 'grande', tamanho };
  const r2 = await deps.fetch(meta.url, { headers: h, signal: AbortSignal.timeout(30000) });
  if (!r2?.ok) return { erro: `midia_${r2?.status}` };
  const buf = Buffer.from(await r2.arrayBuffer());
  if (buf.length > BYTES_MAX) return { erro: 'grande', tamanho: buf.length };
  // Integridade: o sha256 do webhook é base64 do SHA-256 do arquivo; o da Graph
  // é hex. Arquivo cortado = transcrição parcial com confiança boa (laboratório).
  const hex = crypto.createHash('sha256').update(buf).digest('hex');
  const b64 = Buffer.from(hex, 'hex').toString('base64');
  let integro;
  if (sha256Webhook) integro = sha256Webhook === b64 || String(sha256Webhook).toLowerCase() === hex;
  else if (meta.sha256) integro = String(meta.sha256).toLowerCase() === hex;
  else integro = true;
  if (integro && tamanho && buf.length !== tamanho) integro = false;
  if (!integro) return { erro: 'integridade', tamanho: buf.length };
  return { buf, mime: meta.mime_type || null };
}

// Token rejeitado: linha bem visível no error.log, no máximo 1 vez por hora.
// O token vem do process.env da SUBIDA: trocar no .env exige pm2 restart.
let ultimoAlertaToken = 0;
function alertaToken(detalhe) {
  if (ultimoAlertaToken && Date.now() - ultimoAlertaToken < 3600000) return;
  ultimoAlertaToken = Date.now();
  console.error(`🚨🎤 META_SYSTEM_TOKEN rejeitado pela Graph (${detalhe}) — sombra sem medir; trocar o token no .env e reiniciar a Claudia`);
}

// ─── Transcrição (roda dentro da fila) ──────────────────────────────────────
function vadDisponivel() {
  return VAD_CANDIDATOS.find((p) => deps.existe(p)) || null;
}

async function transcreverAgora(buf, dur) {
  if (deps.memoriaLivre() < MEMORIA_MIN) return { ok: false, motivo: 'memoria', dur };
  const t0 = Date.now();
  let dir = null;
  try {
    dir = await fsp.mkdtemp(path.join(deps.tmpdir(), PREFIXO_TMP));
    vigiarSaida();
    emVoo.dirs.add(dir);
    const ogg = path.join(dir, 'a.ogg');
    const wav = path.join(dir, 'a.wav');
    const saida = path.join(dir, 'r');
    await fsp.writeFile(ogg, buf);
    const dec = await rodar('opusdec', ['--quiet', '--rate', '16000', ogg, wav], 20000);
    const st = await fsp.stat(wav).catch(() => null);
    if (dec.code !== 0 || !st || st.size <= 44 + 3200) {
      return { ok: false, motivo: dec.morto ? 'timeout' : 'opusdec', dur, ms: Date.now() - t0, detalhe: `code=${dec.code}` };
    }
    const durWav = (st.size - 44) / 32000;
    const vad = vadDisponivel();
    // audio_ctx proporcional encurta o encode de áudio curto (janela de 30 s
    // cheia = 12,7 s; 10 s de áudio com -ac = 4 s). Só com VAD e só < 30 s:
    // acima disso truncaria cada janela.
    const ac = vad && durWav < 30 ? Math.ceil(durWav * 50) + 64 : 0;
    const args = [
      '-m', WHISPER_MODELO, '-f', wav, '-l', 'pt', '-t', '1', '-bs', '1', '-bo', '1',
      '-ac', String(ac), ...(vad ? ['--vad', '-vm', vad] : []),
      '-nt', '-np', '-ojf', '-of', saida,
    ];
    // Pior caso medido a quente: 186 s de áudio em 129 s SEM VAD. Base de 90 s
    // (era 20): a 1ª transcrição depois de horas parado carrega o modelo (488 MB)
    // do disco — no VPS em 01/10, áudio de 9,7 s levou 31,7 s de whisper (a
    // quente: 5,7 s) e foi morto no prazo antigo de 32 s. ~1 áudio/dia = quase
    // sempre a frio.
    const timeoutMs = Math.min(300000, 90000 + 1200 * durWav);
    const w = await rodar(WHISPER_BIN, args, timeoutMs);
    if (w.morto) return { ok: false, motivo: 'timeout', dur: durWav, ms: Date.now() - t0, whisperMs: w.ms, detalhe: `prazo=${Math.round(timeoutMs / 1000)}s`, vad: !!vad };
    let json;
    try {
      json = JSON.parse(await fsp.readFile(saida + '.json', 'utf8'));
    } catch {
      return { ok: false, motivo: 'whisper', dur: durWav, ms: Date.now() - t0, whisperMs: w.ms, detalhe: `code=${w.code} ${String(w.stderr).slice(-120).replace(/\s+/g, ' ')}`, vad: !!vad };
    }
    const a = avaliar(json, durWav);
    const ok = a.nivel === 'ok' || a.nivel === 'incerta';
    // Métricas também em baixa/vazio (revisão 01/10): a calibração depende delas.
    return { ok, motivo: ok ? null : a.nivel, ...a, dur: durWav, whisperMs: w.ms, ms: Date.now() - t0, vad: !!vad };
  } finally {
    if (dir) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      emVoo.dirs.delete(dir);
    }
  }
}

/**
 * Baixa, confere, converte e transcreve um áudio do WhatsApp.
 * NUNCA lança: toda falha vira { ok:false, motivo }.
 * motivo: download | integridade | formato | longo | memoria | fila |
 *         opusdec | whisper | timeout | vazio | baixa | erro
 */
export async function transcreverAudio({ mediaId, sha256, mime } = {}) {
  const t0 = Date.now();
  try {
    // Só Ogg/Opus: 100% dos 139 áudios do log. mp3/m4a/aac o opusdec não lê e
    // o ffmpeg não está instalado.
    if (mime && !/^audio\/ogg\b/i.test(mime) && !/opus/i.test(mime)) {
      return { ok: false, motivo: 'formato', detalhe: String(mime).slice(0, 40), ms: 0 };
    }
    let d;
    try {
      d = await comPrazo(baixar(mediaId, sha256), PRAZO_DOWNLOAD_MS, { erro: 'download_prazo' });
    } catch (e) {
      d = { erro: e?.name === 'TimeoutError' ? 'download_timeout' : 'download_excecao' };
    }
    if (d.erro === 'grande') return { ok: false, motivo: 'longo', detalhe: 'grande', ms: Date.now() - t0 };
    if (d.erro === 'integridade') return { ok: false, motivo: 'integridade', ms: Date.now() - t0 };
    if (d.erro === 'token') {
      alertaToken(d.detalhe);
      return { ok: false, motivo: 'download', detalhe: d.detalhe, tokenRejeitado: true, ms: Date.now() - t0 };
    }
    if (d.erro) return { ok: false, motivo: 'download', detalhe: d.erro, ms: Date.now() - t0 };
    const dur = duracaoOggOpus(d.buf);
    if (dur == null) return { ok: false, motivo: 'formato', detalhe: 'nao-ogg-opus', ms: Date.now() - t0 };
    if (dur > DUR_MAX_S) return { ok: false, motivo: 'longo', dur, ms: Date.now() - t0 };
    const r = await enfileirar(() => transcreverAgora(d.buf, dur));
    return { ...r, dur: r.dur ?? dur, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, motivo: 'erro', detalhe: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 };
  }
}

// Diretórios de um crash no meio da transcrição (o finally não rodou). Roda no
// 1º áudio da sombra de cada subida. Só apaga o que tem o nosso prefixo.
export async function limparOrfaos() {
  try {
    const base = deps.tmpdir();
    const nomes = (await fsp.readdir(base)).filter((n) => n.startsWith(PREFIXO_TMP));
    for (const n of nomes) await fsp.rm(path.join(base, n), { recursive: true, force: true }).catch(() => {});
    if (nomes.length) console.log(`🎤 ${nomes.length} diretório(s) temporário(s) de áudio órfão(s) apagado(s)`);
  } catch { /* nada a limpar */ }
}

// Texto curto para o console: duração, nível, métricas — sem texto, url ou token.
export function resumoTranscricao(r) {
  const dur = r?.dur != null ? `${Math.round(r.dur)}s` : '?s';
  const metricas = r?.tokens != null
    ? ` fala=${r.fala ?? '?'}s p=${r.media ?? '-'} baixa=${r.fracBaixa ?? '-'} tokens=${r.tokens} pps=${r.wps} pps_fala=${r.wpsFala ?? '?'}${r.descartouAlucinacao ? ' alucinacao_descartada' : ''}`
    : '';
  const tempo = ` ms=${r?.ms ?? '?'}${r?.whisperMs != null ? ` whisper=${r.whisperMs}` : ''}${r?.vad === false ? ' SEM_VAD' : ''}`;
  if (!r?.ok) return `dur=${dur} FALHA=${r?.motivo}${r?.detalhe ? `(${r.detalhe})` : ''}${metricas}${tempo}`;
  return `dur=${dur} nivel=${r.nivel}${metricas}${tempo}`;
}

// ─── Tabela audio_sombra (patients.db) ──────────────────────────────────────
// Tabela NOVA e isolada: nenhum leitor existente (rate limit, janela de 24h,
// reengajamento, monitor de campanhas) a enxerga. Criada no 1º áudio da sombra,
// não na subida (com off o banco fica igual). Telefone só pelo sufixo-8.
// wamid UNIQUE = dedupe da reentrega da Meta que sobrevive a restart.
let tabelaOk = false;
function garantirTabela() {
  if (tabelaOk) return;
  deps.db().exec(`
    CREATE TABLE IF NOT EXISTS audio_sombra (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      wamid            TEXT    UNIQUE NOT NULL,
      fone8            TEXT    NOT NULL,         -- sufixo-8 do telefone
      ts_audio         INTEGER,                  -- msg.timestamp do webhook (s)
      ts_chegada       INTEGER,                  -- chegada ao webhook (s)
      ts_proc          INTEGER,                  -- fim do processamento (s)
      modo             TEXT,                     -- sombra | on (tratado como sombra)
      takeover         INTEGER,                  -- 1 = Dr. Diego na conversa na chegada
      estado           TEXT DEFAULT 'pendente',  -- pendente | ok | falha
      nivel            TEXT,                     -- ok | incerta | baixa | vazio (rótulo provisório)
      motivo           TEXT,                     -- motivo da falha (null se ok)
      detalhe          TEXT,
      dur_s            REAL,                     -- duração do arquivo
      fala_s           REAL,                     -- trecho de fala (offsets do whisper)
      palavras         INTEGER,
      tokens           INTEGER,                  -- tokens de palavra (sem pontuação/especiais)
      p_medio          REAL,                     -- média de p SEM pontuação/especiais
      p_medio_bruto    REAL,                     -- média de p com pontuação (comparação)
      frac_baixa       REAL,                     -- fração de tokens de palavra com p < 0,5
      pps_fala         REAL,                     -- palavras/s do trecho de FALA
      pps_arquivo      REAL,                     -- palavras/s do arquivo inteiro
      alucinacao       INTEGER,                  -- 1 = segmento descartado pelo filtro
      laco             INTEGER,                  -- 1 = frase repetida em laço
      vad              INTEGER,
      ms_total         INTEGER,
      whisper_ms       INTEGER,
      texto            TEXT,                     -- transcrição (dado de saúde: o monitor não imprime)
      texto_descartado TEXT,                     -- o que o filtro de alucinação tirou
      intervalo_prox_s INTEGER,                  -- até o próximo áudio do mesmo fone8 (preenchido depois)
      created_at       TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_audio_sombra_fone ON audio_sombra(fone8, ts_audio);
  `);
  tabelaOk = true;
}

const sqlv = (x) => (x === undefined || (typeof x === 'number' && !Number.isFinite(x)) ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x);

// Registra a chegada. Devolve o id da linha, 0 se o wamid já existe (reentrega)
// ou null se o banco falhou (segue transcrevendo; o dedupe em memória cobre).
function registrarChegada({ wamid, fone8, tsAudio, modo, takeover }) {
  try {
    garantirTabela();
    const d = deps.db();
    const r = d.prepare(`INSERT OR IGNORE INTO audio_sombra (wamid, fone8, ts_audio, ts_chegada, modo, takeover) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sqlv(wamid), sqlv(fone8), sqlv(tsAudio), Math.floor(Date.now() / 1000), sqlv(modo), sqlv(takeover));
    if (!r?.changes) return 0;
    const id = Number(r.lastInsertRowid);
    // Intervalo desde o áudio anterior do mesmo telefone: preenche a linha ANTERIOR
    // (calibra o debounce de lote com áudio; p10 do log = 15 s).
    if (tsAudio) {
      d.prepare(`UPDATE audio_sombra SET intervalo_prox_s = ? - ts_audio
                 WHERE id = (SELECT id FROM audio_sombra WHERE fone8 = ? AND id <> ? AND ts_audio IS NOT NULL
                             AND ts_audio <= ? AND intervalo_prox_s IS NULL ORDER BY ts_audio DESC, id DESC LIMIT 1)`)
        .run(tsAudio, sqlv(fone8), id, tsAudio);
    }
    return id;
  } catch (e) {
    console.warn('⚠️🎤 [SOMBRA] audio_sombra (chegada):', e?.message);
    return null;
  }
}

function registrarResultado(id, r) {
  if (!id) return;
  try {
    deps.db().prepare(`UPDATE audio_sombra SET ts_proc = ?, estado = ?, nivel = ?, motivo = ?, detalhe = ?, dur_s = ?, fala_s = ?,
        palavras = ?, tokens = ?, p_medio = ?, p_medio_bruto = ?, frac_baixa = ?, pps_fala = ?, pps_arquivo = ?,
        alucinacao = ?, laco = ?, vad = ?, ms_total = ?, whisper_ms = ?, texto = ?, texto_descartado = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000), r?.ok ? 'ok' : 'falha', sqlv(r?.nivel ?? null), sqlv(r?.ok ? null : (r?.motivo || 'erro')),
        sqlv(r?.detalhe ? String(r.detalhe).slice(0, 160) : null), sqlv(arred(r?.dur, 2)), sqlv(r?.fala ?? null),
        sqlv(r?.palavras ?? null), sqlv(r?.tokens ?? null), sqlv(r?.media ?? null), sqlv(r?.mediaBruta ?? null),
        sqlv(r?.fracBaixa ?? null), sqlv(r?.wpsFala ?? null), sqlv(r?.wps ?? null),
        sqlv(r?.descartouAlucinacao ?? null), sqlv(r?.tinhaLaco ?? null), sqlv(r?.vad ?? null),
        sqlv(r?.ms ?? null), sqlv(r?.whisperMs ?? null), sqlv(r?.texto || null), sqlv(r?.descartado || null), id);
  } catch (e) {
    console.warn('⚠️🎤 [SOMBRA] audio_sombra (resultado):', e?.message);
  }
}

// ─── Entrada do webhook ─────────────────────────────────────────────────────
const vistos = new Map();   // wamid -> ts (2ª barreira, se o banco falhar)
let avisouOn = false;
let orfaos = null;
const MOTIVOS_TECNICOS = new Set(['download', 'opusdec', 'whisper', 'timeout', 'memoria', 'fila', 'erro']);
let falhasTecnicas = [];    // ts das falhas técnicas na última hora (só log)

/**
 * Áudio recebido no webhook (chamada sem await, com .catch). Com off retorna
 * na 1ª linha, antes de qualquer log, timer, gravação ou download.
 * opts.takeoverAtivo: () => boolean, leitura sem efeito colateral.
 */
export async function receberAudio(msg, { takeoverAtivo } = {}) {
  const modo = modoAudio();
  if (modo === 'off') return; // como sempre foi: áudio ignorado
  try {
    if (modo === 'on' && !avisouOn) {
      avisouOn = true;
      console.warn('⚠️🎤 AUDIO_TRANSCRICAO=on ainda não existe nesta versão — tratado como SOMBRA (nada vai ao paciente)');
    }
    const agora = Date.now();
    const fone8 = String(msg?.from || '').replace(/\D/g, '').slice(-8) || '?';
    const wamid = String(msg?.id || `sem-wamid-${agora}-${fone8}`);
    if (vistos.has(wamid)) {
      console.log(`🎤 [SOMBRA] áudio ${wamid.slice(0, 30)}... reentregue pela Meta — ignorado`);
      return;
    }
    if (vistos.size > 2000) for (const [w, ts] of vistos) if (agora - ts > 24 * 3600000) vistos.delete(w);
    vistos.set(wamid, agora);
    let takeover = null;
    try { takeover = takeoverAtivo ? (takeoverAtivo() ? 1 : 0) : null; } catch { /* sem leitura */ }
    const tsAudio = Number(msg?.timestamp) || null;
    const id = registrarChegada({ wamid, fone8, tsAudio, modo, takeover });
    if (id === 0) {
      console.log(`🎤 [SOMBRA] áudio ${wamid.slice(0, 30)}... já registrado (reentrega) — ignorado`);
      return;
    }
    console.log(`🎤 [SOMBRA] áudio de …${fone8} recebido — transcrevendo só para registro${takeover ? ' (Dr. Diego na conversa)' : ''}`);
    if (!orfaos) orfaos = limparOrfaos();
    await orfaos;
    const a = msg?.audio || {};
    const r = await transcreverAudio({ mediaId: a.id, sha256: a.sha256, mime: a.mime_type });
    registrarResultado(id, r);
    console.log(`🎤 [SOMBRA] …${fone8}: ${resumoTranscricao(r)}`);
    // Falha sistêmica (whisper quebrado, opusdec removido, token): só log. Na
    // sombra nenhum paciente é afetado — não há card nem WhatsApp ao Dr. Diego.
    if (!r?.ok && MOTIVOS_TECNICOS.has(r?.motivo)) {
      const t = Date.now();
      falhasTecnicas = falhasTecnicas.filter((x) => t - x < 3600000);
      falhasTecnicas.push(t);
      if (falhasTecnicas.length === 3) console.error(`🚨🎤 [SOMBRA] 3 falhas técnicas de transcrição na última hora (última: ${r.motivo}${r.detalhe ? '/' + r.detalhe : ''}) — conferir o log 🎤 (sombra: nenhum paciente afetado)`);
    }
  } catch (e) {
    console.warn('⚠️🎤 [SOMBRA] erro no registro do áudio:', e?.message);
  }
}
