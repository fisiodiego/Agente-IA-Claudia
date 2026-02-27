import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { processMessage } from './agent.js';
import { logMessage } from './patientManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'data', 'auth');

fs.mkdirSync(AUTH_DIR, { recursive: true });

// Logger silencioso para não poluir o console
const logger = pino({ level: 'silent' });

let sock = null;
let isConnected = false;
let ownPhone = null;

// ─── Controle de Tomada de Controle Humana ─────────────────────────────────────
// Quando o Dr. Diego responde manualmente, a Cláudia pausa para aquele paciente.

const HUMAN_TAKEOVER_DURATION = 30 * 60 * 1000; // 30 minutos em ms
const humanTakeoverMap = new Map();   // phone -> timestamp de expiração
const recentBotSentPhones = new Map(); // phone -> timestamp (anti-falso-positivo)
const knownPatientJids = new Set();    // JIDs de pacientes que já enviaram mensagem

/**
 * Extrai o número limpo de um JID do WhatsApp.
 * Suporta @s.whatsapp.net, @c.us e @lid (multi-device).
 */
function extractPhone(jid) {
  if (!jid) return null;
  return jid
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@c\.us$/, '')
    .replace(/@lid$/, '')
    .replace(/\D/g, '');
}

/**
 * Ativa o modo humano para um número (bot pausa as respostas).
 */
function activateHumanTakeover(phone) {
  const wasActive = humanTakeoverMap.has(phone) && humanTakeoverMap.get(phone) > Date.now();
  humanTakeoverMap.set(phone, Date.now() + HUMAN_TAKEOVER_DURATION);
  if (!wasActive) {
    console.log(`👨‍⚕️ Dr. Diego assumiu conversa com ${phone} — Cláudia pausada por 30 min`);
  }
}

/**
 * Verifica se o modo humano está ativo para um número.
 */
function isHumanActive(phone) {
  if (!humanTakeoverMap.has(phone)) return false;
  if (humanTakeoverMap.get(phone) > Date.now()) return true;

  // Timer expirado — remove e retoma bot
  humanTakeoverMap.delete(phone);
  console.log(`🤖 Cláudia retomando conversa com ${phone}`);
  return false;
}

// ─── Inicialização do WhatsApp ─────────────────────────────────────────────────

/**
 * Inicia a conexão com o WhatsApp via Baileys.
 * Retorna a função de envio de mensagens para uso no agendador.
 */
export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`📱 Conectando ao WhatsApp (versão ${version.join('.')})`);

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['Clínica Bot', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  // ─── Eventos de Conexão ────────────────────────────────────────────────────

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n' + '═'.repeat(60));
      console.log('📲 ESCANEIE O QR CODE ABAIXO COM O WHATSAPP:');
      console.log('   (Configurações > Aparelhos conectados > Conectar aparelho)');
      console.log('═'.repeat(60) + '\n');
      qrcode.generate(qr, { small: true });
      console.log('\n' + '─'.repeat(60) + '\n');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`🔌 Conexão encerrada. Motivo: ${statusCode}`);

      if (shouldReconnect) {
        console.log('🔄 Reconectando em 5 segundos...');
        setTimeout(startWhatsApp, 5000);
      } else {
        console.log('🚫 Sessão encerrada. Delete a pasta data/auth e reinicie.');
      }
    }

    if (connection === 'open') {
      isConnected = true;
      ownPhone = sock.user?.id?.split(':')[0] || null;
      console.log(`\n✅ WhatsApp conectado! Número: ${ownPhone}`);
      console.log('🤖 Agente pronto para receber mensagens!\n');
    }
  });

  // Salvar credenciais quando atualizadas
  sock.ev.on('creds.update', saveCreds);

  // ─── Receber Mensagens ─────────────────────────────────────────────────────

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      await handleIncomingMessage(msg);
    }
  });

  return sendMessage;
}

// ─── Processamento de Mensagens ────────────────────────────────────────────────

async function handleIncomingMessage(msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Ignorar grupos e status
    if (jid.endsWith('@g.us')) return;
    if (jid === 'status@broadcast') return;

    // Extrair número limpo (suporta @s.whatsapp.net, @c.us, @lid)
    const phone = extractPhone(jid);
    if (!phone) return;

    // ── Mensagens enviadas pelo próprio número ──────────────────────────────
    if (msg.key.fromMe) {
      // Ignorar mensagens para o próprio número (reflexo interno)
      if (ownPhone && phone === ownPhone) return;

      // Ignorar JIDs @lid que NÃO são pacientes conhecidos (mensagens internas de dispositivo)
      if (jid.endsWith('@lid') && !knownPatientJids.has(jid)) return;

      // Verificar se foi o bot que enviou (janela de 5s anti-falso-positivo)
      const sentTime = recentBotSentPhones.get(phone);
      if (sentTime && sentTime > Date.now()) return; // Foi o bot

      // Se chegou aqui, foi o Dr. Diego respondendo manualmente
      activateHumanTakeover(phone);
      return;
    }

    // ── Mensagem recebida do paciente ───────────────────────────────────────

    const text = extractMessageText(msg);
    if (!text || text.trim() === '') return;

    // Registrar JID como paciente conhecido (para detectar takeover via @lid)
    knownPatientJids.add(jid);

    console.log(`📩 Mensagem de ${phone}: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);

    // Marcar como lida (mesmo em modo humano)
    await sock.readMessages([msg.key]);

    // Se o Dr. Diego está ativo nessa conversa, Cláudia fica quieta
    if (isHumanActive(phone)) {
      console.log(`👨‍⚕️ Modo humano ativo para ${phone} — Cláudia não responde`);
      logMessage(phone, 'inbound', text);
      return;
    }

    logMessage(phone, 'inbound', text);

    // Mostrar "digitando..."
    await sock.sendPresenceUpdate('composing', jid);

    // Processar com o agente de IA
    const reply = await processMessage(phone, text);

    // Parar de "digitar"
    await sock.sendPresenceUpdate('paused', jid);

    // Enviar resposta usando o JID original (preserva @lid se necessário)
    if (reply) {
      await sendMessageToJid(jid, phone, reply);
    }

  } catch (error) {
    console.error('❌ Erro ao processar mensagem:', error.message);
  }
}

// ─── Envio de Mensagens ────────────────────────────────────────────────────────

/**
 * Envia mensagem usando o JID original (preserva @lid para multi-device).
 * Uso interno: respostas a mensagens recebidas.
 */
async function sendMessageToJid(jid, phone, text) {
  if (!sock || !isConnected) throw new Error('WhatsApp não está conectado');

  // Marcar como "enviado pelo bot" por 60s (janela ampla para evitar race condition)
  recentBotSentPhones.set(phone, Date.now() + 60000);
  setTimeout(() => recentBotSentPhones.delete(phone), 61000);

  await sock.sendMessage(jid, { text });
  logMessage(phone, 'outbound', text);
  console.log(`📤 Mensagem enviada para ${phone}`);
}

/**
 * Envia uma mensagem de texto para um número de telefone.
 * Uso externo: follow-ups agendados pelo scheduler.
 * @param {string} phone - número sem formatação (ex: 5511999999999)
 * @param {string} text - texto da mensagem
 */
export async function sendMessage(phone, text) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp não está conectado');
  }

  const cleanPhone = String(phone).replace(/\D/g, '');
  const jid = `${cleanPhone}@s.whatsapp.net`;

  // Marcar como "enviado pelo bot" por 60s (janela ampla para evitar race condition)
  recentBotSentPhones.set(cleanPhone, Date.now() + 60000);
  setTimeout(() => recentBotSentPhones.delete(cleanPhone), 61000);

  await sock.sendMessage(jid, { text });
  logMessage(cleanPhone, 'outbound', text);
  console.log(`📤 Mensagem enviada para ${cleanPhone}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extrai o texto de diferentes tipos de mensagem do WhatsApp.
 */
function extractMessageText(msg) {
  const content = msg.message;
  if (!content) return null;

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    null
  );
}



/**
 * Verifica se o WhatsApp está conectado.
 */
export function isWhatsAppConnected() {
  return isConnected;
}
