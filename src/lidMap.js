import { queries } from './database.js';

/**
 * Normaliza telefone: remove tudo que não é dígito.
 */
export function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone).replace(/\D/g, '');
}

/**
 * Valida se é um telefone real (não um LID).
 * Telefones reais com código de país: 10-13 dígitos.
 * LIDs extraídos de JIDs: 14-15+ dígitos.
 */
export function isValidPhone(phone) {
  if (!phone) return false;
  const digits = normalizePhone(phone);
  return digits.length >= 10 && digits.length <= 13;
}

/**
 * Resolve o telefone real de um JID @lid.
 * 1. Consulta tabela phone_lid_map (mapeamento persistente)
 * 2. Busca mensagens outbound recentes (últimos 5 min) — resolve mas NÃO salva
 * Retorna null se não conseguiu resolver com número válido.
 */
export function resolveLidPhone(lidJid) {
  // 1. Mapeamento persistente
  const mapping = queries.getLidMapping.get(lidJid);
  if (mapping) {
    const normalized = normalizePhone(mapping.phone);
    if (isValidPhone(normalized)) {
      console.log(`🗺️ LID ${lidJid} → ${normalized} (mapeamento salvo, nome: ${mapping.push_name || '?'})`);
      return normalized;
    }
    console.log(`⚠️ LID ${lidJid} tem mapeamento inválido (${mapping.phone}) — ignorando`);
  }

  // 2. Mensagens outbound recentes — resolve temporariamente mas NÃO salva
  //    (só saveLidMapping, chamado após confirmação do CRM, persiste o mapeamento)
  const recentPhones = queries.getRecentOutboundPhones.all();
  const validPhones = recentPhones.filter(r => isValidPhone(r.phone));
  if (validPhones.length === 1) {
    const phone = normalizePhone(validPhones[0].phone);
    console.log(`🔍 LID ${lidJid} → ${phone} (único outbound recente — temporário, não salvo)`);
    return phone;
  }

  console.log(`❓ LID ${lidJid} não resolvido (${recentPhones.length} outbound, ${validPhones.length} válidos)`);
  return null;
}

/**
 * Salva mapeamento LID → telefone real (chamado após identificação via CRM).
 * Normaliza e só salva se o telefone for válido (não LID).
 */
export function saveLidMapping(lidJid, phone, pushName = null) {
  if (!lidJid || !phone) return;
  const normalized = normalizePhone(phone);
  if (!isValidPhone(normalized)) {
    console.log(`⚠️ Não salvando mapeamento LID ${lidJid} → ${phone} (não parece telefone real)`);
    return;
  }
  queries.upsertLidMapping.run({ lid_jid: lidJid, phone: normalized, push_name: pushName || null });
  console.log(`💾 Mapeamento salvo: ${lidJid} → ${normalized}${pushName ? ' (' + pushName + ')' : ''}`);
}
