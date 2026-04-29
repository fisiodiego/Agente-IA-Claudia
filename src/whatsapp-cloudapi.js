/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WhatsApp Cloud API — Módulo de comunicação via API oficial do Meta
 *  Substitui o Baileys (não-oficial) por webhook + Graph API
 * ═══════════════════════════════════════════════════════════════════════════
 */

import express from 'express';
import { processMessage } from './agent.js';
import { isValidPhone } from './lidMap.js';
import { logMessage, wasRecentBotOutbound } from './patientManager.js';

// ─── Config via .env ────────────────────────────────────────────────────────
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;   // 1045271008668555
const ACCESS_TOKEN    = process.env.WA_ACCESS_TOKEN;
const VERIFY_TOKEN    = process.env.WA_VERIFY_TOKEN || 'holiz_claudia_2026';
const WEBHOOK_PORT    = parseInt(process.env.WEBHOOK_PORT || '8443', 10);
const CHAKRA_PLUGIN_ID = process.env.CHAKRA_PLUGIN_ID;
const GRAPH_API_URL   = CHAKRA_PLUGIN_ID
  ? `https://api.chakrahq.com/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/v22.0/${PHONE_NUMBER_ID}/messages`
  : `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

// ─── Debounce: agrupa mensagens rápidas do mesmo contato ────────────────────
const messageBuffer = new Map(); // phone -> { texts: [], pushName, timer }
const DEBOUNCE_MS = 8000;
const processingLock = new Map(); // phone -> true (se está processando)
const pendingQueue = new Map(); // phone -> { texts: [], pushName } (msgs que chegaram durante processamento)

// ─── Estado ─────────────────────────────────────────────────────────────────
let isConnected = false;

// ─── Controle de Tomada de Controle Humana ──────────────────────────────────
const HUMAN_TAKEOVER_DURATION = 30 * 60 * 1000; // 30 minutos
const humanTakeoverMap = new Map();   // phone -> timestamp de expiração
const recentBotSentPhones = new Map(); // phone -> timestamp (anti-falso-positivo)
const botSentMessageIds = new Set(); // IDs de mensagens enviadas pelo bot (limpa apos 5min)

/**
 * Normaliza número BR: garante formato 55 + DDD (2 dígitos) + número (9 dígitos).
 * Ex: 71993507884 -> 5571993507884, 557193507884 -> 5571993507884
 */
function normalizeBRPhone(phone) {
  if (!phone) return phone;
  let p = String(phone).replace(/\D/g, '');
  if (p.length >= 10 && p.length <= 11) {
    p = '55' + p;
  }
  // Cloud API usa formato com 9 (13 dígitos): 5571987093555
  // Manter o formato completo (13 dígitos) para Cloud API
  return p;
}

/**
 * Ativa o modo humano para um número (bot pausa as respostas por 30 min).
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
  // Checar pausa global
  if (humanTakeoverMap.has("__ALL__")) {
    if (humanTakeoverMap.get("__ALL__") > Date.now()) return true;
    humanTakeoverMap.delete("__ALL__");
  }
  if (!humanTakeoverMap.has(phone)) return false;
  if (humanTakeoverMap.get(phone) > Date.now()) return true;
  humanTakeoverMap.delete(phone);
  console.log(`🤖 Cláudia retomando conversa com ${phone}`);
  return false;
}

// ─── Envio de Mensagens via Graph API ───────────────────────────────────────

/**
 * Envia uma mensagem de texto via WhatsApp Cloud API.
 * @param {string} phone - Número sem formatação (ex: 5571987093555)
 * @param {string} text - Texto da mensagem
 */
export async function sendMessage(phone, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('WA_ACCESS_TOKEN ou WA_PHONE_NUMBER_ID não configurado');
  }

  const rawPhone = String(phone).replace(/^lid_/, '');
  if (!isValidPhone(rawPhone)) {
    console.warn(`⛔ Telefone inválido, mensagem NÃO enviada: ${phone}`);
    return;
  }

  const cleanPhone = normalizeBRPhone(rawPhone);

  // Marcar como "enviado pelo bot" por 60s
  recentBotSentPhones.set(cleanPhone, Date.now() + 60000);
  setTimeout(() => recentBotSentPhones.delete(cleanPhone), 61000);

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'text',
    text: { body: text },
  };

  const res = await fetch(GRAPH_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`❌ Erro ao enviar mensagem para ${cleanPhone}:`, JSON.stringify(err));
    throw new Error(`Cloud API error ${res.status}: ${err?.error?.message || 'Unknown'}`);
  }

  // Rastrear ID e telefone da mensagem enviada pelo bot
  try {
    const resData = await res.json();
    const msgId = resData?.messages?.[0]?.id || resData?._data?.whatsappMessageId;
    if (msgId) {
      botSentMessageIds.add(msgId);
      setTimeout(() => botSentMessageIds.delete(msgId), 5 * 60 * 1000);
      console.log('[BOT_TRACK] Msg ID rastreado: ' + msgId.slice(0, 30) + '...');
    }
  } catch (e) {
    console.warn('[BOT_TRACK] Falha ao rastrear msg ID:', e.message);
  }
  recentBotSentPhones.set(cleanPhone, Date.now() + 60000);
  setTimeout(() => recentBotSentPhones.delete(cleanPhone), 61000);

  logMessage(cleanPhone, 'outbound', text);
  console.log(`📤 [CloudAPI] Mensagem enviada para ${cleanPhone}`);
}



/**
 * Envia uma mensagem usando Message Template (para fora da janela de 24h)
 * Usa pass-through do Chakra com formato nativo da Graph API
 * Templates devem existir na WABA do Chakra (122098688444003982)
 */
export async function sendTemplateMessage(phone, templateName, parameters = []) {
  const rawPhone = String(phone).replace(/^lid_/, '');
  if (!isValidPhone(rawPhone)) {
    console.warn('[TEMPLATE] Telefone invalido:', phone);
    return false;
  }
  const cleanPhone = normalizeBRPhone(rawPhone);

  const components = [];
  if (parameters.length > 0) {
    components.push({
      type: 'body',
      parameters: parameters.map(p => ({ type: 'text', text: String(p) }))
    });
  }

  const body = {
    messaging_product: 'whatsapp',
    to: cleanPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'pt_BR' },
      components: components
    }
  };

  try {
    const res = await fetch(GRAPH_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseData = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error(`[TEMPLATE] Erro ao enviar ${templateName} para ${cleanPhone}:`, JSON.stringify(responseData));
      return false;
    }

    // Rastrear ID e telefone do template enviado pelo bot
    const tmplMsgId = responseData?.messages?.[0]?.id || responseData?._data?.whatsappMessageId;
    if (tmplMsgId) {
      botSentMessageIds.add(tmplMsgId);
      setTimeout(() => botSentMessageIds.delete(tmplMsgId), 5 * 60 * 1000);
      console.log('[BOT_TRACK] Template ID rastreado: ' + tmplMsgId.slice(0, 30) + '...');
    }
    recentBotSentPhones.set(cleanPhone, Date.now() + 60000);
    setTimeout(() => recentBotSentPhones.delete(cleanPhone), 61000);

    console.log(`\U0001f4e4 [TEMPLATE] ${templateName} enviado para ${cleanPhone}`);
    logMessage(cleanPhone, 'outbound', `[TEMPLATE] ${templateName}`, 'template');
    return true;
  } catch (err) {
    console.error(`[TEMPLATE] Erro:`, err.message);
    return false;
  }
}
// ─── Processamento de mensagens recebidas ───────────────────────────────────

async function handleIncomingMessage(from, text, pushName) {
  const phone = normalizeBRPhone(from);
  if (!phone) return;

  // Ignorar números não-brasileiros
  if (!phone.startsWith('55')) {
    console.log(`🚫 Mensagem de número não-BR ignorada: ${phone}`);
    return;
  }

  console.log(`📩 [CloudAPI] Mensagem de ${phone}${pushName ? ' (' + pushName + ')' : ''}: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);

  // Se o Dr. Diego está ativo nessa conversa, Cláudia fica quieta
  if (isHumanActive(phone)) {
    console.log(`👨‍⚕️ Modo humano ativo para ${phone} — Cláudia não responde`);
    logMessage(phone, 'inbound', text);
    return;
  }

  logMessage(phone, 'inbound', text);

  // Debounce: agrupa mensagens rápidas
  const existing = messageBuffer.get(phone);
  if (existing) {
    existing.texts.push(text);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => processBuffered(phone), DEBOUNCE_MS);
    return;
  }
  messageBuffer.set(phone, {
    texts: [text],
    pushName,
    timer: setTimeout(() => processBuffered(phone), DEBOUNCE_MS),
  });
}

async function processBuffered(phone) {
  const buf = messageBuffer.get(phone);
  if (!buf) return;
  messageBuffer.delete(phone);

  const { texts, pushName } = buf;

  // Se já está processando msg desse paciente, enfileirar
  if (processingLock.get(phone)) {
    const pending = pendingQueue.get(phone);
    if (pending) {
      pending.texts.push(...texts);
    } else {
      pendingQueue.set(phone, { texts: [...texts], pushName });
    }
    console.log("⏳ Msgs enfileiradas para " + phone + " (processamento em andamento): " + texts.length + " msg(s)");
    return;
  }

  // Adquirir lock e processar
  processingLock.set(phone, true);
  const combinedText = texts.join('\n');

  try {
    const result = await processMessage(phone, combinedText, { pushName });

    const reply = (result && typeof result === 'object') ? result.reply : result;
    const shouldTakeover = result?.activateHumanTakeover === true;

    if (reply) {
      await sendMessage(phone, reply);
    }

    if (shouldTakeover) {
      activateHumanTakeover(phone);
    }
  } catch (error) {
    console.error('❌ Erro ao processar mensagem:', error.message);
  } finally {
    // Liberar lock
    processingLock.delete(phone);

    // Processar msgs que ficaram na fila durante o processamento
    const pending = pendingQueue.get(phone);
    if (pending) {
      pendingQueue.delete(phone);
      console.log("📨 Processando " + pending.texts.length + " msg(s) enfileirada(s) de " + phone);
      // Colocar no buffer e disparar processamento
      messageBuffer.set(phone, {
        texts: pending.texts,
        pushName: pending.pushName,
        timer: setTimeout(() => processBuffered(phone), 1000),
      });
    }
  }
}

// ─── Webhook Server ─────────────────────────────────────────────────────────

// ─── Instagram Lead Capture ─────────────────────────────────────────────────

const igLeadCache = new Map(); // igUserId -> timestamp (dedup: 1 lead por user a cada 24h)
const IG_DEDUP_MS = 24 * 60 * 60 * 1000;

/**
 * Busca info do usuario Instagram via Graph API
 */
async function getInstagramUserInfo(igUserId) {
  try {
    const token = process.env.IG_PAGE_ACCESS_TOKEN || process.env.META_SYSTEM_TOKEN;
    if (!token) return { username: null, name: null };
    const res = await fetch(`https://graph.instagram.com/v21.0/${igUserId}?fields=username,name&access_token=${token}`);
    if (!res.ok) return { username: null, name: null };
    return await res.json();
  } catch {
    return { username: null, name: null };
  }
}

/**
 * Cria lead no CRM a partir de interacao no Instagram
 */
async function createInstagramLeadInCRM(igUserId, username, displayName, type, detail) {
  // Dedup: 1 lead por user a cada 24h
  const lastCreated = igLeadCache.get(igUserId);
  if (lastCreated && Date.now() - lastCreated < IG_DEDUP_MS) {
    console.log(`[Instagram] Lead de @${username || igUserId} ja criado nas ultimas 24h - ignorando`);
    return;
  }

  try {
    const id = `ig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const name = displayName || username || `Instagram ${igUserId}`;
    const notes = type === 'dm'
      ? `DM via Instagram: "${(detail || '').substring(0, 200)}"`
      : type === 'mention'
        ? `Mencionou @institutoholiz no Instagram (media: ${detail || 'N/A'})`
        : `Comentou no Instagram: "${(detail || '').substring(0, 200)}"`;

    const body = {
      id,
      patientName: name,
      phone: null,
      type: 'lead',
      status: 'pendente',
      source: 'instagram',
      interest: null,
      notes: notes + (username ? ` | @${username}` : ''),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const CRM_URL = process.env.CRM_API_URL || 'https://crm.holiz.com.br/api/integration';
    const API_KEY = process.env.CRM_API_KEY || '';

    const res = await fetch(CRM_URL + '/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      igLeadCache.set(igUserId, Date.now());
      console.log(`[Instagram] Lead criado no CRM: ${name} (@${username || 'N/A'}) - ${type}`);
    } else {
      console.warn(`[Instagram] CRM respondeu ${res.status}`);
    }
  } catch (err) {
    console.error('[Instagram] Erro ao criar lead:', err.message);
  }
}

/**
 * Processa eventos de webhook do Instagram
 */
async function handleInstagramWebhook(body) {
  const entries = body.entry || [];

  for (const entry of entries) {
    // ── DMs (Instagram Messaging) ──
    const messaging = entry.messaging || [];
    for (const event of messaging) {
      if (!event.message) continue; // Ignorar delivery/read receipts
      const senderId = event.sender?.id;
      const recipientId = event.recipient?.id;
      if (!senderId || senderId === recipientId) continue; // Ignorar msgs enviadas por nos

      const text = event.message?.text || '';
      console.log(`[Instagram DM] De ${senderId}: "${text.substring(0, 80)}"`);

      const userInfo = await getInstagramUserInfo(senderId);
      await createInstagramLeadInCRM(
        senderId,
        userInfo.username,
        userInfo.name,
        'dm',
        text
      );
    }

    // ── Mentions e Comments (via changes) ──
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};

      if (change.field === 'mentions') {
        const mediaId = value.media_id || 'N/A';
        const commentId = value.comment_id;
        console.log(`[Instagram Mention] Media: ${mediaId}, Comment: ${commentId}`);

        // Buscar info do comentario para pegar o user
        let userId = null;
        let username = null;
        try {
          const token = process.env.IG_PAGE_ACCESS_TOKEN || process.env.META_SYSTEM_TOKEN;
          if (commentId && token) {
            const res = await fetch(`https://graph.facebook.com/v21.0/${commentId}?fields=from{id,username}&access_token=${token}`);
            if (res.ok) {
              const data = await res.json();
              userId = data.from?.id;
              username = data.from?.username;
            }
          }
        } catch {}

        if (userId) {
          await createInstagramLeadInCRM(userId, username, null, 'mention', mediaId);
        } else {
          await createInstagramLeadInCRM(
            `mention-${commentId || Date.now()}`,
            null,
            'Mencao Instagram',
            'mention',
            mediaId
          );
        }
      }

      if (change.field === 'comments') {
        const commentText = value.text || '';
        const fromUser = value.from || {};
        const userId = fromUser.id;
        const username = fromUser.username;

        console.log(`[Instagram Comment] De @${username || userId}: "${commentText.substring(0, 80)}"`);

        if (userId) {
          await createInstagramLeadInCRM(userId, username, null, 'comment', commentText);
        }
      }
    }
  }
}
function createWebhookServer() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: isConnected, timestamp: new Date().toISOString() });
  });

  // Webhook verification (Meta envia GET para validar)
  app.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado com sucesso');
      return res.status(200).send(challenge);
    }

    console.warn('⚠️ Falha na verificação do webhook');
    return res.sendStatus(403);
  });

  // Receber mensagens (Meta envia POST)
  app.post('/webhook', (req, res) => {
    // Responder 200 imediatamente (Meta exige resposta rápida)
    res.sendStatus(200);

    try {
      // DEBUG: logar todo webhook recebido
      console.log("[WEBHOOK DEBUG]", JSON.stringify(req.body).substring(0, 800));
      const body = req.body;

      // Instagram webhook handler
      if (body.object === 'instagram') {
        handleInstagramWebhook(body).catch(err => console.error('[Instagram] Erro:', err.message));
        return;
      }
      if (body.object !== 'whatsapp_business_account') return;

      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value;
          if (!value) continue;

          // ── Message Echoes (mensagens enviadas pelo app/Chakra UI) ──
          if (change.field === 'message_echoes' || change.field === 'messages') {
            // Detectar echoes para human takeover
            if (change.field === 'message_echoes') {
              const echoMessages = value.messages || value.message_template_sends || [];
              for (const echo of echoMessages) {
                const to = echo.to || echo.recipient_id;
                if (!to) continue;
                const phone = normalizeBRPhone(to);

                // Verificar se foi enviado pelo bot (ignorar)
                if (recentBotSentPhones.has(phone) && recentBotSentPhones.get(phone) > Date.now()) {
                  console.log(`🤖 Echo de mensagem do bot para ${phone} — ignorando`);
                  continue;
                }

                // Foi enviado manualmente (Dr. Diego) → ativar human takeover
                console.log(`👨‍⚕️ Echo detectado: Dr. Diego enviou mensagem para ${phone} via app`);
                activateHumanTakeover(phone);
              }
              continue;
            }

            // ── Mensagens recebidas (field === 'messages') ──
            const messages = value.messages || [];
            for (const msg of messages) {
              // Extrair texto da mensagem (suporta text, button e interactive)
              let msgText = null;
              if (msg.type === 'text' && msg.text?.body) {
                msgText = msg.text.body;
              } else if (msg.type === 'button' && msg.button?.text) {
                msgText = msg.button.text;
                console.log('[BUTTON] Paciente clicou botão: "' + msgText + '"');
              } else if (msg.type === 'interactive' && msg.interactive?.button_reply?.title) {
                msgText = msg.interactive.button_reply.title;
                console.log('[INTERACTIVE] Paciente clicou: "' + msgText + '"');
              }

              if (msgText) {
                const from = msg.from;
                const contact = (value.contacts || []).find(c => c.wa_id === from);
                const pushName = contact?.profile?.name || null;

                handleIncomingMessage(from, msgText, pushName);
              }
              // TODO: suportar mensagens de imagem, áudio, etc.
            }

            // ── Statuses (entregue, lido, etc.) ──
            const statuses = value.statuses || [];
            for (const status of statuses) {
              if (status.status === 'read') {
                console.log(`👁️ Mensagem lida por ${status.recipient_id}`);
              }
              // Detectar mensagem enviada pelo Dr. Diego (status sent/delivered com ID NAO rastreado pelo bot)
              if ((status.status === 'sent' || status.status === 'delivered') && status.id && status.recipient_id) {
                const recipientPhone = normalizeBRPhone(status.recipient_id);

                if (botSentMessageIds.has(status.id)) {
                  // Status da propria msg do bot (ID rastreado) — ignorar silenciosamente
                } else {
                  // ID NAO esta no rastreamento do bot — pode ser msg do Dr. Diego
                  // Grace period curto (5s): cobre caso raro de falha no rastreio de ID do bot
                  const last8 = recipientPhone.replace(/\D/g, '').slice(-8);
                  let justSentByBot = false;
                  for (const [ph, expiry] of recentBotSentPhones.entries()) {
                    if (ph.endsWith(last8) && expiry > Date.now() && (expiry - Date.now()) > 55000) {
                      // recentBotSentPhones armazena Date.now() + 60000
                      // Se faltam >55s, foi setado ha menos de 5s — grace period curto
                      justSentByBot = true;
                      break;
                    }
                  }

                  if (justSentByBot) {
                    console.log('[BOT_TRACK] Status ' + status.status + ' para ' + recipientPhone + ' ignorado (grace 5s)');
                  } else {
                    console.log('\ud83d\udc68\u200d\u2695\ufe0f Dr. Diego enviou msg para ' + recipientPhone + ' (status ' + status.status + ', wamid: ' + (status.id || '').slice(0, 30) + ')');
                    activateHumanTakeover(recipientPhone);
                  }
                }
              }
            }
          }

          // ── SMB Message Echoes (CoEx - mensagens do WhatsApp Business App) ──
          if (change.field === 'smb_message_echo' || change.field === 'smb_message_echoes') {
            const smbMessages = value.messages || [];
            for (const smbMsg of smbMessages) {
              const to = smbMsg.to || smbMsg.recipient_id;
              if (!to) continue;
              const phone = normalizeBRPhone(to);

              console.log(`👨‍⚕️ SMB Echo (CoEx): Dr. Diego respondeu via WhatsApp Business App para ${phone}`);
              activateHumanTakeover(phone);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Erro ao processar webhook:', error.message);
    }
  });


  // Chakra Webhooks (Beta) - detecta echoes para human takeover
  app.post('/webhook-chakra', (req, res) => {
    res.sendStatus(200);
    try {
      const event = req.body;
      console.log('[CHAKRA WEBHOOK]', JSON.stringify(event).substring(0, 500));
      if (event.event === 'smb_message_echo' || event.event === 'message_echo') {
        const payload = event.payload;
        if (!payload) return;
        const msg = payload.message || {};
        const to = msg.to || payload.recipientId || '';
        if (!to) return;
        const phone = normalizeBRPhone(to);
        if (recentBotSentPhones.has(phone) && recentBotSentPhones.get(phone) > Date.now()) {
          console.log('[CHAKRA] Echo do bot para ' + phone + ' - ignorando');
          return;
        }
        console.log('[CHAKRA] Dr. Diego respondeu para ' + phone + ' - Claudia pausada 30min');
        activateHumanTakeover(phone);
      }
    } catch (error) {
      console.error('Erro Chakra webhook:', error.message);
    }
  });

    // ── Endpoint para pausar Cláudia manualmente (Dr. Diego) ──
  app.post('/pause/:phone', (req, res) => {
    const phone = normalizeBRPhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Telefone inválido' });

    const minutes = parseInt(req.body?.minutes || '30', 10);
    humanTakeoverMap.set(phone, Date.now() + minutes * 60 * 1000);
    console.log(`👨‍⚕️ Cláudia pausada manualmente para ${phone} por ${minutes} min`);
    res.json({ ok: true, phone, pausedUntil: new Date(humanTakeoverMap.get(phone)).toISOString() });
  });

  // ── Endpoint para retomar Cláudia ──
  app.post('/resume/:phone', (req, res) => {
    const phone = normalizeBRPhone(req.params.phone);
    humanTakeoverMap.delete(phone);
    console.log(`🤖 Cláudia retomada manualmente para ${phone}`);
    res.json({ ok: true, phone });
  });

  // ── Endpoint para pausar Cláudia para TODOS ──
  app.post('/pause-all', (req, res) => {
    const minutes = parseInt(req.body?.minutes || '30', 10);
    const expiry = Date.now() + minutes * 60 * 1000;
    humanTakeoverMap.set('__ALL__', expiry);
    console.log(`👨‍⚕️ Cláudia pausada para TODOS por ${minutes} min`);
    res.json({ ok: true, pausedUntil: new Date(expiry).toISOString() });
  });

  app.post('/resume-all', (req, res) => {
    humanTakeoverMap.delete('__ALL__');
    console.log(`🤖 Cláudia retomada para TODOS`);
    res.json({ ok: true });
  });

  return app;
}

// ─── Inicialização ──────────────────────────────────────────────────────────

export async function startWhatsApp() {
  // Validar configuração
  if (!PHONE_NUMBER_ID) {
    console.error('❌ WA_PHONE_NUMBER_ID não definido no .env');
    process.exit(1);
  }
  if (!ACCESS_TOKEN) {
    console.error('❌ WA_ACCESS_TOKEN não definido no .env');
    process.exit(1);
  }

  const app = createWebhookServer();

  return new Promise((resolve) => {
    app.listen(WEBHOOK_PORT, () => {
      isConnected = true;
      console.log(`\n✅ WhatsApp Cloud API conectado!`);
      console.log(`📡 Webhook escutando na porta ${WEBHOOK_PORT}`);
      console.log(`📞 Phone Number ID: ${PHONE_NUMBER_ID}`);
      console.log(`🤖 Agente pronto para receber mensagens!\n`);

      // Retornar a função sendMessage (mesma interface do Baileys)
      resolve(sendMessage);
    });
  });
}


export function isWhatsAppConnected() {
  return isConnected;
}
