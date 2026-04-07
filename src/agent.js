import Anthropic from '@anthropic-ai/sdk';
import { CRM_TOOLS } from './tools.js';
import { handleToolCall } from './toolHandler.js';
import {
  getPatientByPhone,
  createPatient,
  completePatientRegistration,
  confirmDischarge,
  getConversationHistory,
  saveMessage,
  markFollowupResponded,
  getPatientFollowups,
  schedulePostConfirmationFollowup,
  setLgpdConsent,
} from './patientManager.js';
import {
  thanksSurveyResponse,
  welcomeMessage,
  appointmentConfirmedReminder,
  appointmentCancelledResponse,
  availabilityHoldingMessage,
  lgpdConsentMessage,
} from './messageTemplates.js';
import { saveLidMapping } from './lidMap.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Anti-duplicata: evita enviar confirmação duas vezes no mesmo período
const recentlyConfirmed = new Map(); // patientId -> timestamp
const CONFIRM_COOLDOWN = 60 * 60 * 1000; // 1 hora

// Phones que receberam lembrete recentemente (set pelo scheduler)
export const recentReminderPhones = new Map(); // phone -> timestamp
export const recentReminderNames = new Map(); // phone -> patientName (set pelo scheduler)
const REMINDER_WINDOW = 24 * 60 * 60 * 1000; // 24h


// ─── Gerador dinâmico de seção de datas ───────────────────────────────────────
// Cache de profissionais (atualizado a cada restart)
let _professionalsCache = null;
let _professionalsCacheTime = 0;

async function getProfessionalsCache() {
  const now = Date.now();
  if (_professionalsCache && (now - _professionalsCacheTime) < 3600000) {
    return _professionalsCache;
  }
  try {
    const { listProfessionals } = await import('./crmApi.js');
    const result = await listProfessionals();
    if (result.ok) {
      _professionalsCache = result.data;
      _professionalsCacheTime = now;
    }
  } catch(e) { /* ignora */ }
  return _professionalsCache || [];
}

function getDateSection(professionalsInfo) {
  const now = new Date(Date.now() - 3*3600000);
  const hoje = now.toISOString().slice(0,10);
  const diasNomes = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
  const hojeDia = diasNomes[now.getDay()];
  const ano = now.getFullYear();
  const amanha = new Date(now.getTime() + 86400000).toISOString().slice(0,10);
  
  const proxDias = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const nome = diasNomes[d.getDay()].toLowerCase();
    const data = d.toISOString().slice(0,10);
    proxDias.push('- "' + nome + '" = ' + data);
  }
  
  return `⚠️ IMPORTANTE: A data de HOJE é ${hoje} (${hojeDia}). O ano atual é ${ano}.
Quando o paciente mencionar datas, SEMPRE use o ano ${ano}.
- "amanhã" = ${amanha}
- "27/03" = ${ano}-03-27

📅 TABELA DE REFERÊNCIA — próximos 7 dias (USE ESTA TABELA, não calcule datas):
${proxDias.join('\n')}

- NUNCA use anos anteriores nas tools
- NUNCA calcule datas mentalmente. SEMPRE consulte a tabela acima.
- Quando a tool check_availability retornar o campo dayOfWeek, USE ESSE VALOR na resposta ao paciente. Não substitua pelo dia que o paciente pediu.

━━━ PROFISSIONAIS DA CLÍNICA (CACHE) ━━━
${professionalsInfo}
⚠️ Use estes IDs diretamente. SÓ use list_professionals se precisar de dados atualizados ou se o profissional não estiver listado aqui.`;
}

// ─── Prompt do Sistema ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a Cláudia, assistente virtual do *Instituto Holiz*, clínica especializada em Osteopatia e Quiropraxia.
Você representa a equipe de atendimento do Instituto Holiz com simpatia, acolhimento e profissionalismo.

━━━ SUAS FUNÇÕES ━━━
1. Responder dúvidas dos pacientes de forma empática, clara e profissional
2. Explicar brevemente sobre Osteopatia e/ou Quiropraxia quando o paciente perguntar
3. Coletar o nome completo de novos pacientes ao primeiro contato
4. Auxiliar com agendamentos
5. Motivar os pacientes sobre a importância do tratamento preventivo e de manutenção
6. Registrar alta confirmada quando o paciente mencionar

━━━ CONHECIMENTO DAS ESPECIALIDADES ━━━

🦴 OSTEOPATIA:
- É uma abordagem terapêutica manual que trata o corpo como um todo integrado
- O osteopata avalia e trata disfunções nos músculos, articulações, fáscias, órgãos e sistema nervoso
- Utiliza técnicas manuais suaves como manipulações, mobilizações e liberações miofasciais
- Indicada para: dores nas costas, hérnia de disco, dores de cabeça, problemas posturais, disfunções digestivas, estresse, entre outros
- Como funciona um atendimento:
  • Anamnese detalhada (histórico de saúde, queixas, estilo de vida)
  • Avaliação postural e de mobilidade
  • Tratamento manual personalizado (dura em média 40 a 50 minutos)
  • Orientações e exercícios para casa

🔩 QUIROPRAXIA:
- É uma profissão de saúde focada no diagnóstico e tratamento das disfunções do sistema neuromusculoesquelético
- O quiropraxista é especialista na coluna vertebral e suas relações com o sistema nervoso
- Utiliza principalmente ajustes vertebrais (manipulações de alta velocidade e baixa amplitude — HVLA)
- Indicada para: dores na coluna (cervical, torácica, lombar), ciática, dores de cabeça tensionais, torcicolo, lesões esportivas, entre outros
- Como funciona um atendimento:
  • Anamnese e avaliação neurológica e ortopédica
  • Análise de radiografias se necessário
  • Ajuste quiroprático preciso e seguro (dura em média 30 a 45 minutos)
  • Orientações posturais e de hábitos saudáveis

━━━ REGRAS DE RESPOSTA SOBRE ESPECIALIDADES ━━━
- Se o paciente perguntar sobre DOR NA COLUNA, AJUSTE, ESTALO ou temas relacionados à coluna → explique a Quiropraxia
- Se o paciente perguntar sobre CORPO, ÓRGÃOS, TENSÃO MUSCULAR, POSTURA GLOBAL, ESTRESSE → explique a Osteopatia
- Se a pergunta for genérica ("quais serviços vocês oferecem?") → apresente as DUAS especialidades brevemente
- Sempre seja breve e objetivo (máximo 5-6 linhas por especialidade)
- Ao final, convide o paciente a agendar uma avaliação

━━━ TOM E ESTILO DE COMUNICAÇÃO ━━━
- Cordial e amigável, como uma recepcionista simpática
- Linguagem leve e acolhedora, mas profissional
- Máximo 1 emoji por mensagem
- Chame pelo primeiro nome
- ⚠️ RESPOSTAS CURTAS: máximo 4-5 linhas por mensagem. WhatsApp não é e-mail!
- NUNCA envie listas longas. Se tem muitos horários, mostre no máximo 3-4 opções
- Vá direto ao ponto. Não repita informações que o paciente já deu
- NÃO interprete mensagens casuais como informação de saúde. "Fique em paz", "como vc ta", "tudo bem" são cumprimentos — responda naturalmente sem assumir que o paciente está relatando seu estado de saúde
- Só envie mensagem de indicação/referência se for um follow-up agendado, NUNCA como resposta a uma conversa casual

━━━ DATA ATUAL ━━━
__DATE_BLOCK__

━━━ REGRAS GERAIS ━━━
- Sempre se comunique em Português do Brasil
- NUNCA forneça diagnósticos ou prescreva tratamentos específicos sem avaliação presencial
- Para emergências, oriente o paciente a ligar para o SAMU (192) ou ir à UPA
- Se o paciente mencionar que está "de alta", "recebeu alta", "terminou o tratamento" ou similar,
  confirme com entusiasmo e inclua a tag: [ALTA_CONFIRMADA]
- Mantenha respostas CURTAS (máximo 4-5 linhas). Isso é WhatsApp, não e-mail!

━━━ REGRA CRÍTICA: NÃO INVENTE DADOS DE AGENDAMENTO ━━━
⚠️ NUNCA confirme, crie ou altere um agendamento sem usar as tools.
- Para VERIFICAR horários: use check_availability OBRIGATORIAMENTE
- Para CRIAR agendamento: use create_appointment OBRIGATORIAMENTE  
- Para CANCELAR: use cancel_appointment OBRIGATORIAMENTE
- Se o paciente pedir para agendar às 15h e o check_availability mostrar que 15h está ocupado, INFORME que está ocupado e sugira outro horário
- NUNCA diga "Está tudo certo para [horário]" sem ter usado create_appointment e recebido confirmação de sucesso
- REGRA DE 12H: agendamentos precisam ter no mínimo 12 horas de antecedência. Se o paciente pedir um horário para daqui a poucas horas, explique gentilmente: "Para garantir que o Dr. Diego visualize seu agendamento a tempo, precisamos de pelo menos 12h de antecedência. Posso verificar os horários disponíveis a partir de amanhã?" 

━━━ REGRA CRÍTICA: NÃO INVENTE NENHUMA INFORMAÇÃO ━━━
⚠️ NUNCA invente, suponha ou deduza QUALQUER informação que não esteja:
  1. Explicitamente neste prompt, OU
  2. Retornada por uma tool do CRM

Isso inclui (mas NÃO se limita a):
- Telefones, emails, PIX, links, endereços
- Horários de agendamento, datas, valores
- Nomes de pacientes, diagnósticos, tratamentos
- Informações sobre pagamento, pacotes ou sessões
- Qualquer dado que o paciente não tenha fornecido na conversa

SE NÃO SABE → NÃO INVENTE. Diga: "Vou verificar essa informação e retorno em breve."
SE A TOOL FALHAR → Diga: "Vou encaminhar para a equipe e retornamos em breve."

Dados REAIS da clínica (os ÚNICOS que você pode fornecer):
- Telefone/WhatsApp: (71) 98709-3555
- PIX (CNPJ): 49.516.188/0001-14
- NUNCA forneça outros dados além destes.

━━━ PLANOS DE TRATAMENTO E PAGAMENTO ━━━
⚠️ NUNCA ofereça PIX, valores ou formas de pagamento sem o paciente pedir.
Só forneça dados de pagamento quando o paciente PERGUNTAR EXPLICITAMENTE sobre valores, formas de pagamento ou como pagar.
Quando o paciente perguntar, utilize exatamente estas informações:

🔸 *Avaliação inicial / Consulta avulsa:*
• R$ 280,00
• Ideal para primeira consulta, check-up ou atendimento isolado
• Já na primeira consulta, realizamos técnicas de correção para iniciar o cuidado imediatamente

🔸 *Planos de tratamento:*
• Embora a consulta avulsa seja importante para avaliação e início do cuidado, é o plano de tratamento que garante evolução consistente
• O plano possibilita:
  - Acompanhamento próximo e progressivo
  - Tratamento personalizado para a necessidade do paciente
  - Melhora duradoura e redução do risco de recidivas
• 💳 Os planos podem ser parcelados no cartão, tornando mais fácil investir na saúde
• Após a avaliação inicial, será proposto um plano de tratamento personalizado, com a quantidade de atendimentos necessários para o caso do paciente

IMPORTANTE: Você pode informar o valor da consulta avulsa (R$ 280,00). Para valores dos planos, informe que serão apresentados de forma personalizada após a avaliação inicial.

━━━ PESQUISA DE SATISFAÇÃO — DOCTORALIA ━━━
Quando for o momento de pedir avaliação (após atendimento), use o link oficial do Doctoralia:
🔗 https://www.doctoralia.com.br/adicionar-opiniao/diego-matos#/opiniao

Ao solicitar a avaliação, reforce de forma amigável a importância do feedback:
- O depoimento ajuda outros pacientes a encontrarem o Instituto Holiz
- As avaliações são fundamentais para a melhoria contínua da qualidade do atendimento
- Leva menos de 2 minutinhos e faz uma grande diferença! ⭐

━━━ REGRA CRÍTICA: DADOS DE AGENDAMENTO ━━━
⚠️ NUNCA invente, suponha ou "adivinhe" horários, datas ou dados de agendamento.
Se o paciente perguntar sobre sua consulta, horário, ou mencionar agendamento:
1. USE a tool "get_patient_appointments" para buscar os dados REAIS do CRM
2. Só informe horários/datas que vieram da tool
3. Se a tool não retornar dados, diga "Vou verificar seu agendamento" e consulte
4. NUNCA diga um horário sem ter consultado a tool primeiro

━━━ FLUXO DE AGENDAMENTO ━━━
Quando o paciente pedir para agendar:
1. Se ele JÁ disse data, horário e/ou especialidade → NÃO pergunte de novo. Use os dados que ele deu.
2. Se falta algum dado → pergunte APENAS o que falta, numa frase curta.
3. Use as tools na ordem:
   a) check_availability → verificar horários livres (use o ID do profissional do CACHE acima, NÃO chame list_professionals antes)
   b) find_or_create_patient → pegar ID do paciente
   c) get_patient_packages → verificar se tem pacote ativo (IMPORTANTE!)
   d) create_appointment → criar o agendamento
⚠️ OTIMIZAÇÃO: NÃO chame list_professionals se o profissional já está no cache acima. Vá direto para check_availability com o ID do cache.
⚠️ NUNCA chame a mesma tool 2 vezes na mesma interação com os mesmos parâmetros.
   Se o paciente TEM pacote ativo, informe: "Será descontado do seu pacote (X/Y sessões usadas)"
   Se NÃO tem pacote, NÃO mencione valor na confirmação. Só informe valor se o paciente PERGUNTAR.


4. Resposta de confirmação: máximo 3 linhas (data, hora, profissional)
5. Se o horário exato não está disponível, sugira no máximo 2-3 alternativas próximas

Exemplo de resposta IDEAL ao confirmar:
"Agendado! ✅
📅 Sexta, 27/03 às 18h
👨‍⚕️ Dr. Diego Matos - Osteopatia"

Exemplo de resposta RUIM (NÃO faça isso):
"Perfeito! Vou agendar... Preciso de algumas informações... 1. Qual dia? 2. Qual especialidade? 3. Qual telefone?" ← se ele já disse, NÃO pergunte

━━━ CONFIRMAÇÃO DE AGENDAMENTO ━━━
Quando o paciente responde *CONFIRMAR* ou *CANCELAR*, o sistema trata automaticamente.

Caso o paciente mencione agendamento de outra forma (ex: "vou agendar", "quero marcar uma consulta"), auxilie normalmente usando as tools do CRM para verificar disponibilidade e criar agendamentos.

━━━ REGRA CRÍTICA: MANTER DATA DO CONTEXTO ━━━
⚠️ Quando o paciente já mencionou uma DATA ou DIA DA SEMANA na conversa e depois envia APENAS o horário (ex: "8h", "14:30", "manhã"):
- USE A MESMA DATA que já estava no contexto da conversa
- NÃO mude a data para outro dia
- NÃO recalcule a data — reutilize a que já foi discutida
Exemplo correto:
  Paciente: "Quero agendar para sexta-feira" → check_availability com sexta
  Paciente: "8h" → check_availability com a MESMA sexta, horário 08:00
Exemplo ERRADO:
  Paciente: "Quero agendar para sexta-feira" → check_availability com sexta
  Paciente: "8h" → check_availability com sábado ← NUNCA FAÇA ISSO

━━━ REGRA CRÍTICA: CORRIGIR AGENDAMENTO ERRADO ━━━
⚠️ Se o paciente disser que a data/horário está ERRADO (ex: "quero na sexta", "não, era segunda", "errou o dia"):
1. PRIMEIRO cancele o agendamento errado com cancel_appointment
2. DEPOIS crie o agendamento correto com create_appointment
- NUNCA crie um segundo agendamento sem cancelar o primeiro
- Ao responder, confirme que o anterior foi cancelado e o novo foi criado

━━━ CANCELAMENTO E REAGENDAMENTO ━━━
Quando o paciente pedir para desmarcar/cancelar:
1. Cancele o agendamento no CRM
2. SEMPRE pergunte se deseja reagendar para outro dia
3. Se sim, inicie o fluxo de agendamento normalmente
Exemplo: "Cancelado! Deseja reagendar para outro dia? Posso verificar os horários disponíveis."

IMPORTANTE na confirmação de agendamento:
- NÃO mostre o valor da consulta na mensagem de confirmação
- Só informe valores se o paciente PERGUNTAR sobre preço

━━━ CONTEXTO DA CLÍNICA ━━━
- Nome: Instituto Holiz
- Especialidades: Osteopatia e Quiropraxia
- Horário de atendimento: Segunda a Sexta, 8h às 18h; Sábado, 8h às 12h
- Para agendamentos: solicite data e horário preferidos pelo paciente
- Em caso de urgências fora do horário, peça para o paciente deixar mensagem que retornaremos

━━━ ENDEREÇO ━━━
📍 Av. Vasco da Gama, nº 3691
Edf. Vasco da Gama Plaza, sala 1401 — Salvador, Bahia
🗺️ Prédio comercial (que parece um QR code 🔳) logo após a ladeira do Acupe de Brotas
😉 Estamos no Waze! Basta buscar por "Instituto Holiz"

Quando o paciente perguntar sobre localização ou como chegar, envie essas informações de forma simpática e completa.`;

// ─── Agente de IA ─────────────────────────────────────────────────────────────

/**
 * Processa uma mensagem recebida de um paciente.
 * @param {string} phone - número do paciente
 * @param {string} message - texto da mensagem recebida
 * @returns {string} - resposta gerada pelo agente
 */
export async function processMessage(phone, message, options = {}) {
  try {
    const { pushName, isLid, lidJid } = options;

    // 1. Buscar ou criar paciente
    let patient = getPatientByPhone(phone);

    // 1b. Se não encontrou OU encontrou incompleto ("Novo Paciente"), buscar no CRM por pushName
    const needsCrmLookup = !patient || (patient && !patient.registration_complete && patient.name === 'Novo Paciente');
    if (needsCrmLookup && pushName && pushName.length >= 3) {
      try {
        const { searchPatientByName } = await import('./crmApi.js');
        const nameResult = await searchPatientByName(pushName);
        if (nameResult.ok && nameResult.data?.found && nameResult.data.patient) {
          const crmPatient = nameResult.data.patient;
          console.log(`🔍 LID ${phone} identificado como ${crmPatient.name} via pushName`);
          if (patient) {
            // Atualizar registro existente com dados do CRM
            completePatientRegistration(patient.id, {
              name: crmPatient.name,
              birth_date: crmPatient.birthDate || null,
              contact_phone: crmPatient.phone,
            });
            patient = { ...patient, name: crmPatient.name, contact_phone: crmPatient.phone, registration_complete: 1 };
            console.log(`✅ Paciente #${patient.id} atualizado com dados do CRM: ${crmPatient.name}`);
            // Salvar mapeamento LID → telefone real se veio de LID
            if (options.lidJid && crmPatient.phone) {
              saveLidMapping(options.lidJid, crmPatient.phone, pushName);
            }
          } else {
            // Criar registro local com dados do CRM
            patient = createPatient({
              name: crmPatient.name,
              phone,
              contact_phone: crmPatient.phone,
              registration_complete: 1,
            });
            // Salvar mapeamento LID → telefone real se veio de LID
            if (options.lidJid && crmPatient.phone) {
              saveLidMapping(options.lidJid, crmPatient.phone, pushName);
            }
          }
        }
      } catch (err) {
        console.warn(`⚠️ Erro pushName CRM: ${err.message}`);
      }
    }

    const isNewPatient = !patient;

    if (!patient) {
      // Cria registro inicial — usa pushName do WhatsApp se disponível
      const initialName = (pushName && pushName.length >= 2 && pushName.length <= 50 && /[a-zA-ZÀ-ú]/.test(pushName)) ? pushName : 'Novo Paciente';
      patient = createPatient({ phone, name: initialName });
      console.log(`👤 Novo contato iniciado: ${phone} (nome: ${initialName})`);
    }

    // 2. Detectar resposta ao lembrete do Simples Agenda (CONFIRMAR / CANCELAR)
    // ⚠️ Deve vir ANTES de tudo — paciente pode confirmar sem nunca ter falado com a Cláudia
    const msgTrimmed = message.trim();

    // Aceita apenas mensagens curtas do paciente (não mensagens longas do sistema)
    const isShortEnough = msgTrimmed.length <= 30;
    // Palavras explícitas de confirmação (sempre tratadas como confirmação)
    const isExplicitConfirm = isShortEnough && /^(confirmar?|confirmou|confirmad[oa]|confirmo|sim[\s,]*confirmo?|ok[\s,]*confirmo?|combinado|estarei l[aá]|vou sim|pode sim)[!\.\s]*$/i.test(msgTrimmed);
    // Respostas curtas genéricas (só contam como confirmação se recebeu lembrete recente)
    const hasRecentReminder = recentReminderPhones.has(phone) && (Date.now() - recentReminderPhones.get(phone)) < REMINDER_WINDOW;
    const isGenericYes = isShortEnough && hasRecentReminder && /^(sim|s|ok|certo|pode|tudo bem|beleza|perfeito|fechado|blz|show)[!\.\s]*$/i.test(msgTrimmed);
    const isConfirming = isExplicitConfirm || isGenericYes;
    const isCancelling = isShortEnough && /^(cancelar?|cancelado|cancelo|nao\s*vou|não\s*vou|nao\s*consigo|não\s*consigo)[!\.\s]*$/i.test(msgTrimmed);

    if (isConfirming) {
      // Anti-duplicata: não envia confirmação duas vezes em 1 hora
      const lastConfirm = recentlyConfirmed.get(patient.id);
      if (lastConfirm && Date.now() - lastConfirm < CONFIRM_COOLDOWN) {
        console.log(`⏭️ Confirmação duplicada ignorada para ${patient.name || phone}`);
        return null;
      }
      recentlyConfirmed.set(patient.id, Date.now());
      saveMessage(patient.id, 'user', message);

      // ── Confirmar no CRM ──────────────────────────────────────
      try {
        const { getPatientAppointments, confirmAppointment, searchPatientByName } = await import('./crmApi.js');
        let confirmed = false;
        // Tenta buscar agendamentos pelo telefone
        const aptsResult = await getPatientAppointments(phone);
        if (aptsResult.ok && aptsResult.data?.appointments?.length) {
          const pending = aptsResult.data.appointments.filter(a => a.status === 'agendado');
          if (pending.length > 0) {
            const confirmResult = await confirmAppointment(pending[0].id);
            if (confirmResult.ok) {
              console.log(`✅ Agendamento ${pending[0].id} confirmado no CRM para ${patient.name || phone}`);
              confirmed = true;
            }
          }
        }
        // Fallback: busca por contact_phone (número real salvo do CRM para LIDs)
        if (!confirmed && patient.contact_phone) {
          const aptsResult3 = await getPatientAppointments(patient.contact_phone);
          if (aptsResult3.ok && aptsResult3.data?.appointments?.length) {
            const pending3 = aptsResult3.data.appointments.filter(a => a.status === 'agendado');
            if (pending3.length > 0) {
              const confirmResult3 = await confirmAppointment(pending3[0].id);
              if (confirmResult3.ok) {
                console.log(`✅ Agendamento ${pending3[0].id} confirmado no CRM (via contact_phone) para ${patient.name}`);
                confirmed = true;
              }
            }
          }
        }
        // Fallback: busca por pushName ou patient.name no CRM
        if (!confirmed) {
          const searchName = (pushName && pushName !== 'Novo Paciente' && pushName.length >= 3) ? pushName : patient.name;
          if (searchName && searchName !== 'Novo Paciente') {
            const nameResult = await searchPatientByName(searchName);
            if (nameResult.ok && nameResult.data?.found && nameResult.data.patient?.phone) {
              const realPhone = nameResult.data.patient.phone;
              const aptsResult2 = await getPatientAppointments(realPhone);
              if (aptsResult2.ok && aptsResult2.data?.appointments?.length) {
                const pending2 = aptsResult2.data.appointments.filter(a => a.status === 'agendado');
                if (pending2.length > 0) {
                  const confirmResult2 = await confirmAppointment(pending2[0].id);
                  if (confirmResult2.ok) {
                    console.log(`✅ Agendamento ${pending2[0].id} confirmado no CRM (via nome "${searchName}") para ${patient.name}`);
                    confirmed = true;
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(`❌ Erro ao confirmar no CRM: ${err.message}`);
      }

      // Se o phone é um LID (não parece BR), tentar pegar o nome correto dos lembretes recentes
      let confirmName = patient.name;
      const isLidPhone = !/^55\d{10,11}$/.test(phone) && !/^\d{10,11}$/.test(phone);
      if (isLidPhone || confirmName === 'Novo Paciente') {
        // Verificar nos lembretes recentes quem foi lembrado
        for (const [remPhone, remName] of recentReminderNames) {
          if (remName && remName !== 'Novo Paciente') {
            // Verificar se esse lembrete é recente (< 24h)
            const remTs = recentReminderPhones.get(remPhone);
            if (remTs && Date.now() - remTs < REMINDER_WINDOW) {
              // Verificar se esse paciente tem agendamento pendente no CRM
              try {
                const { getPatientAppointments } = await import('./crmApi.js');
                const crmApts = await getPatientAppointments(remPhone);
                if (crmApts.ok && crmApts.data?.appointments?.some(a => a.status === 'agendado' || a.status === 'confirmado')) {
                  confirmName = remName;
                  console.log(`🔄 LID confirmação: corrigido nome de "${patient.name}" para "${confirmName}" via lembrete recente (${remPhone})`);
                  // Confirmar o agendamento do paciente correto no CRM
                  const pending = crmApts.data.appointments.filter(a => a.status === 'agendado');
                  if (pending.length > 0) {
                    const { confirmAppointment } = await import('./crmApi.js');
                    await confirmAppointment(pending[0].id);
                    console.log(`✅ Agendamento ${pending[0].id} confirmado no CRM para ${confirmName}`);
                  }
                  break;
                }
              } catch (e) { console.warn(`⚠️ Erro ao verificar lembrete: ${e.message}`); }
            }
          }
        }
      }
      const firstName = confirmName.split(' ')[0];
      const reply = appointmentConfirmedReminder(confirmName);
      saveMessage(patient.id, 'assistant', reply);
      schedulePostConfirmationFollowup(patient.id);
      console.log(`📅 Agendamento confirmado por ${confirmName || phone}`);
      return reply;
    }
    if (isCancelling) {
      saveMessage(patient.id, 'user', message);

      // ── Cancelar no CRM ──────────────────────────────────────
      try {
        const { getPatientAppointments, cancelAppointment, searchPatientByName } = await import('./crmApi.js');
        let cancelled = false;
        // Tenta buscar agendamentos pelo telefone
        const aptsResult = await getPatientAppointments(phone);
        if (aptsResult.ok && aptsResult.data?.appointments?.length) {
          const pending = aptsResult.data.appointments.filter(a => a.status === 'agendado' || a.status === 'confirmado');
          if (pending.length > 0) {
            const cancelResult = await cancelAppointment(pending[0].id, 'Cancelado pelo paciente via WhatsApp');
            if (cancelResult.ok) {
              console.log(`❌ Agendamento ${pending[0].id} cancelado no CRM para ${patient.name || phone}`);
              cancelled = true;
            }
          }
        }
        // Fallback: busca por nome (para pacientes LID)
        if (!cancelled && patient.name) {
          const nameResult = await searchPatientByName(patient.name);
          if (nameResult.ok && nameResult.data?.found && nameResult.data.patient?.phone) {
            const realPhone = nameResult.data.patient.phone;
            const aptsResult2 = await getPatientAppointments(realPhone);
            if (aptsResult2.ok && aptsResult2.data?.appointments?.length) {
              const pending2 = aptsResult2.data.appointments.filter(a => a.status === 'agendado' || a.status === 'confirmado');
              if (pending2.length > 0) {
                const cancelResult2 = await cancelAppointment(pending2[0].id, 'Cancelado pelo paciente via WhatsApp');
                if (cancelResult2.ok) {
                  console.log(`❌ Agendamento ${pending2[0].id} cancelado no CRM (via nome) para ${patient.name}`);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(`❌ Erro ao cancelar no CRM: ${err.message}`);
      }

      const reply = appointmentCancelledResponse(patient.name);
      saveMessage(patient.id, 'assistant', reply);
      console.log(`❌ Agendamento cancelado por ${patient.name || phone}`);
      return reply;
    }

    // 3. Se é novo paciente → verificar se já existe no CRM antes de pedir dados
    if (isNewPatient) {
      saveMessage(patient.id, 'user', message);
      try {
        const { searchPatientByPhone, searchPatientByName, getUpcomingAppointments } = await import('./crmApi.js');
        
        // Detectar se é LID (não é telefone BR válido)
        const isLID = !/^55\d{10,11}$/.test(phone) && !/^\d{10,11}$/.test(phone);
        
        let crmResult = null;
        
        if (!isLID) {
          // Busca normal por telefone
          crmResult = await searchPatientByPhone(phone);
        }
        
        // Se não encontrou por telefone (qualquer tipo), tenta buscar por pushName no CRM
        if (!crmResult?.found && pushName && pushName.length >= 3) {
          try {
            const nameResult = await searchPatientByName(pushName);
            if (nameResult?.ok && nameResult.data?.found && nameResult.data.patient) {
              crmResult = { found: true, patient: nameResult.data.patient };
              console.log("✅ Paciente encontrado no CRM por pushName " + pushName + ": " + nameResult.data.patient.name);
            }
          } catch (e) {
            console.log("⚠️ Erro ao buscar por pushName: " + e.message);
          }
        }

        // Se é LID e ainda não encontrou, tenta extrair nome da mensagem
        if (!crmResult?.found && isLID) {
          // Tenta buscar nos agendamentos de hoje para encontrar por nome
          const today = new Date();
          const brt = new Date(today.getTime() - 3 * 60 * 60 * 1000);
          const todayStr = brt.toISOString().slice(0, 10);
          const aptsResult = await getUpcomingAppointments(todayStr, { includeConfirmed: true });
          if (aptsResult.ok && aptsResult.data?.length) {
            // Verificar se a mensagem contém um nome de paciente agendado hoje
            const msgLower = message.toLowerCase().trim();
            for (const apt of aptsResult.data) {
              const aptNameLower = apt.patientName?.toLowerCase() || '';
              const firstName = aptNameLower.split(' ')[0];
              // Se a mensagem é curta (tipo "Bom dia", "Cheguei", "Irmão") não dá pra saber
              // Mas se mandar o nome, podemos encontrar
              if (firstName && msgLower.includes(firstName) && firstName.length > 2) {
                crmResult = await searchPatientByPhone(apt.patientPhone);
                if (crmResult?.found) {
                  console.log(`✅ Paciente LID encontrado via agendamento de hoje: ${apt.patientName}`);
                  break;
                }
              }
            }
          }
          
          // Se ainda não encontrou, tenta buscar pelo texto da mensagem como nome
          if (!crmResult?.found && message.trim().length > 3 && message.trim().length < 60) {
            const nameResult = await searchPatientByName(message.trim());
            if (nameResult?.ok && nameResult.data?.found) {
              crmResult = { found: true, patient: nameResult.data.patient };
              console.log(`✅ Paciente LID encontrado por nome na mensagem: ${nameResult.data.patient.name}`);
            }
          }
        }
        
        if (crmResult && crmResult.found && crmResult.patient) {
          const crmPat = crmResult.patient;
          console.log(`✅ Paciente encontrado no CRM: ${crmPat.name} (${phone})`);
          const { queries } = await import('./database.js');
          queries.updatePatient.run({
            id: patient.id,
            name: crmPat.name,
            email: crmPat.email || '',
            specialty: crmPat.specialty || 'osteopatia',
            notes: '',
          });
          const db = (await import('./database.js')).default;
          db.prepare(`UPDATE patients SET
            birth_date = COALESCE(@birth_date, birth_date),
            contact_phone = COALESCE(@contact_phone, contact_phone),
            registration_complete = 1, lgpd_consent = 1,
            updated_at = datetime('now','localtime')
            WHERE id = @id`).run({
            id: patient.id,
            birth_date: crmPat.birthDate || null,
            contact_phone: phone,
          });
          const firstName = crmPat.name.split(' ')[0];
          const reply = `Ol\u00e1, *${firstName}*! 😊 Que bom falar com voc\u00ea!\n\nSou a *Cl\u00e1udia*, assistente virtual do Instituto Holiz. Como posso te ajudar hoje?`;
          saveMessage(patient.id, 'assistant', reply);
          return reply;
        }
      } catch (err) {
        console.log(`⚠️ Erro ao buscar paciente no CRM: ${err.message}`);
      }
      const welcome = welcomeMessage();
      saveMessage(patient.id, 'assistant', welcome);
      return welcome;
    }

    // 3b. Verificar se está aguardando consentimento LGPD
    // (dados já coletados, mas paciente ainda não confirmou o consentimento)
    const hasAllData = patient.name && patient.name !== 'Novo Paciente';  // nascimento e telefone coletados no agendamento

    if (!patient.registration_complete && hasAllData && !patient.lgpd_consent) {
      saveMessage(patient.id, 'user', message);
      if (isLgpdConfirmation(message)) {
        setLgpdConsent(patient.id);
        completePatientRegistration(patient.id, {
          name: patient.name,
          birth_date: patient.birth_date,
          contact_phone: patient.contact_phone,
        });
        console.log(`✅ Consentimento LGPD confirmado por ${patient.name}`);
        const reply = `Perfeito, *${patient.name}*! Cadastro concluído com sucesso.\n\nComo posso te ajudar hoje?`;
        saveMessage(patient.id, 'assistant', reply);
        return reply;
      } else {
        // Reenviar mensagem LGPD se paciente não confirmou
        const reply = lgpdConsentMessage(patient.name);
        saveMessage(patient.id, 'assistant', reply);
        return reply;
      }
    }

    // 3c. Se o cadastro ainda está incompleto, tentar coletar dados
    if (!patient.registration_complete) {
      // Para pacientes LID sem nome, tentar buscar no CRM antes de pedir dados
      const isLID = !/^55\d{10,11}$/.test(phone) && !/^\d{10,11}$/.test(phone);
      if (isLID && (!patient.name || patient.name === 'Novo Paciente')) {
        try {
          const { searchPatientByName, searchPatientByPhone, getUpcomingAppointments } = await import('./crmApi.js');
          
          // 1. Tenta buscar pelo texto da mensagem como nome
          const trimmed = message.trim();
          if (trimmed.length > 3 && trimmed.length < 60 && /^[A-ZÀ-Ú][a-zà-ú]/.test(trimmed)) {
            const nameResult = await searchPatientByName(trimmed);
            if (nameResult?.ok && nameResult.data?.found && nameResult.data.patient) {
              const crmPat = nameResult.data.patient;
              console.log(`✅ Paciente LID identificado por nome: ${crmPat.name}`);
              const { queries } = await import('./database.js');
              const db = (await import('./database.js')).default;
              queries.updatePatient.run({ id: patient.id, name: crmPat.name, email: crmPat.email || '', specialty: crmPat.specialty || 'osteopatia', notes: '' });
              db.prepare(`UPDATE patients SET registration_complete = 1, lgpd_consent = 1, contact_phone = COALESCE(@contact_phone, contact_phone), birth_date = COALESCE(@birth_date, birth_date), updated_at = datetime('now','localtime') WHERE id = @id`).run({ id: patient.id, contact_phone: crmPat.phone || phone, birth_date: crmPat.birthDate || null });
              const firstName = crmPat.name.split(' ')[0];
              saveMessage(patient.id, 'user', message);
              const reply = `Olá, *${firstName}*! 😊 Te identifiquei!\n\nSou a *Cláudia*, assistente virtual do Instituto Holiz. Como posso te ajudar?`;
              saveMessage(patient.id, 'assistant', reply);
              return reply;
            }
          }
          
          // 2. Tenta buscar nos agendamentos de hoje
          const now = new Date();
          const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
          const todayStr = brt.toISOString().slice(0, 10);
          const aptsResult = await getUpcomingAppointments(todayStr, { includeConfirmed: true });
          if (aptsResult.ok && aptsResult.data?.length) {
            const nowHour = brt.getHours();
            // Buscar pacientes agendados para a próxima hora (provável ser quem está mandando "cheguei")
            const nearbyApts = aptsResult.data.filter(a => {
              const aptHour = parseInt(a.time?.split(':')[0] || '0');
              return Math.abs(aptHour - nowHour) <= 1 && a.status !== 'cancelado';
            });
            // Se só tem 1 paciente perto desse horário que ainda não confirmou por outro meio, pode ser ele
            // Mas não assumir automaticamente — só logar para debug
            if (nearbyApts.length > 0) {
              console.log(`ℹ️ LID sem nome, ${nearbyApts.length} agendamento(s) próximo(s): ${nearbyApts.map(a => a.patientName).join(', ')}`);
            }
          }
        } catch (err) {
          console.log(`⚠️ Erro ao buscar LID no CRM: ${err.message}`);
        }
      }
      return await handleRegistration(patient, message);
    }


    // 5. Verificar se é resposta de pesquisa de satisfação (score 1-5)
    const surveyScore = extractSurveyScore(message);
    if (surveyScore) {
      const pendingFollowups = getPatientFollowups(patient.id)
        .filter(f => f.type === 'pesquisa_satisfacao' && f.status === 'enviado');

      if (pendingFollowups.length > 0) {
        markFollowupResponded(pendingFollowups[0].id, message);
        return thanksSurveyResponse(surveyScore);
      }
    }

    // 3. Buscar histórico de conversa
    const history = getConversationHistory(patient.id);

    // 4. Salvar mensagem do usuário
    saveMessage(patient.id, 'user', message);

    // 5. Chamar Claude API
    const messages = [
      ...history,
      { role: 'user', content: message },
    ];

    let currentMessages = [...messages];
    let assistantReply = "";
    
    // Inject patient context into system prompt so Claude uses the correct phone
    const patientPhone = patient.contact_phone || phone;
    const patientContext = `\n\n\u2501\u2501\u2501 CONTEXTO DO PACIENTE ATUAL \u2501\u2501\u2501\nNome: ${patient.name || "Desconhecido"}\nTelefone para tools: ${patientPhone}\n\u26a0\ufe0f Ao usar tools (get_patient_appointments, find_or_create_patient, etc), SEMPRE use este telefone: ${patientPhone}`;
    
    // Load professionals cache
    const profs = await getProfessionalsCache();
    const professionalsInfo = profs.map(p => `- ${p.name} | ID: ${p.id} | Especialidade(s): ${p.specialty}`).join('\n') || 'Nenhum profissional cacheado. Use list_professionals.';

    // Tool use loop - keep calling until we get a text response
    while (true) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: SYSTEM_PROMPT.replace("__DATE_BLOCK__", getDateSection(professionalsInfo)) + patientContext,
        messages: currentMessages,
        tools: CRM_TOOLS,
      });

      // Check if response has tool_use blocks
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const textBlocks = response.content.filter(b => b.type === 'text');

      if (toolUseBlocks.length === 0) {
        // No tools called, get text response
        assistantReply = textBlocks.map(b => b.text).join("") || "";
        break;
      }

      // Execute tools and add results
      currentMessages.push({ role: 'assistant', content: response.content });
      
      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        console.log("Tool call: " + toolBlock.name + " " + JSON.stringify(toolBlock.input));
        const result = await handleToolCall(toolBlock.name, toolBlock.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result,
        });
      }
      currentMessages.push({ role: 'user', content: toolResults });
      
      // If there was also text with the tool call, capture it
      if (textBlocks.length > 0) {
        assistantReply = textBlocks.map(b => b.text).join("");
      }
    }

    // 6. Salvar resposta do assistente
    saveMessage(patient.id, 'assistant', assistantReply);

    // 7. Verificar se a resposta indica alta confirmada
    if (assistantReply.includes('[ALTA_CONFIRMADA]')) {
      console.log(`🏥 Alta confirmada para paciente #${patient.id} (${patient.name})`);
      confirmDischarge(patient.id);

      // Remover a tag da resposta enviada ao paciente
      const cleanReply = assistantReply
        .replace('[ALTA_CONFIRMADA]', '')
        .trim();

      return cleanReply;
    }

    return assistantReply;

  } catch (error) {
    console.error('❌ Erro no agente:', error.message);
    return 'Desculpe, tive uma dificuldade técnica agora. Por favor, tente novamente em instantes ou ligue para a clínica. 🙏';
  }
}

// ─── Coleta de Cadastro ────────────────────────────────────────────────────────

/**
 * Gerencia o fluxo de coleta de dados do novo paciente (nome, nascimento, telefone).
 * Usa Claude para extrair os dados da mensagem de forma flexível.
 */
async function handleRegistration(patient, message) {
  saveMessage(patient.id, 'user', message);

  // Pede ao Claude para extrair os 3 campos da mensagem
  const extraction = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system: `Você extrai dados de cadastro de uma mensagem de WhatsApp de paciente de clínica.
Extraia APENAS o que estiver presente na mensagem. Retorne JSON neste formato exato:
{"name": "Nome Completo ou null", "birth_date": "DD/MM/AAAA ou null", "contact_phone": "apenas dígitos sem espaço ou null"}

Padrões comuns que você deve reconhecer:
- O paciente pode enviar os 3 dados em linhas separadas (nome na 1ª linha, data na 2ª, telefone na 3ª)
- O nome pode ter 2 a 5 palavras, com ou sem preposições (de, da, dos, etc.)
- A data pode vir COM separadores: DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA
- A data pode vir SEM separadores: "15091983" = 15/09/1983 | "150983" = 15/09/1983 | "1509983" = 15/09/1983 (interprete com bom senso)
- Sempre retorne a data no formato DD/MM/AAAA
- O telefone pode vir com ou sem DDD, com traços, espaços ou parênteses — retorne SOMENTE os dígitos
- Se o telefone tiver 8 dígitos sem DDD, não invente o DDD

Não inclua explicações, apenas o JSON.`,
    messages: [{ role: 'user', content: message }],
  });

  let extracted = { name: null, birth_date: null, contact_phone: null };
  try {
    let raw = extraction.content[0].text.trim();

    // Remove blocos de código markdown que o modelo às vezes inclui (```json ... ```)
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    extracted = JSON.parse(raw);
    console.log(`🔍 Extração de cadastro:`, JSON.stringify(extracted));
  } catch (e) {
    console.warn(`⚠️ Falha ao parsear JSON do Haiku: "${extraction.content[0]?.text}" — tentando fallback regex`);

    // Fallback: extração direta por regex para o formato de 3 linhas
    const lines = message.trim().split('\n').map(l => l.trim()).filter(Boolean);

    // Data COM separadores: DD/MM/AAAA
    const dateWithSep = /(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/;
    // Data SEM separadores: DDMMYYYY (8 dígitos) ou DDMMYY (6 dígitos) ou typos como 7 dígitos
    const dateNoSep   = /\b(\d{6,8})\b/;
    const phoneRegex  = /(?:\(?\d{2}\)?\s?)?\d{4,5}[\-\s]?\d{4}/;

    const dateMatchSep = message.match(dateWithSep);
    if (dateMatchSep) {
      extracted.birth_date = `${dateMatchSep[1]}/${dateMatchSep[2]}/${dateMatchSep[3]}`;
    } else {
      // Tentar data sem separadores em cada linha
      for (const line of lines) {
        if (/^\d{6,8}$/.test(line)) {
          const d = line.replace(/\D/g, '');
          if (d.length === 8) {
            // DDMMYYYY
            extracted.birth_date = `${d.slice(0,2)}/${d.slice(2,4)}/${d.slice(4,8)}`;
          } else if (d.length === 6) {
            // DDMMYY → assume 1900s ou 2000s
            const yy = parseInt(d.slice(4,6));
            const yyyy = yy > 30 ? `19${d.slice(4,6)}` : `20${d.slice(4,6)}`;
            extracted.birth_date = `${d.slice(0,2)}/${d.slice(2,4)}/${yyyy}`;
          } else if (d.length === 7) {
            // Typo comum: DMMYYYY ou DDMMYYY — tenta DDMMYYYY inserindo dígito
            extracted.birth_date = `${d.slice(0,2)}/${d.slice(2,4)}/19${d.slice(4,7)}`;
          }
          break;
        }
      }
    }

    // Telefone: linha com 10-11 dígitos (DDD + número)
    const phoneMatch = message.match(phoneRegex);
    if (phoneMatch) {
      extracted.contact_phone = phoneMatch[0].replace(/\D/g, '');
    } else {
      for (const line of lines) {
        const digits = line.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 11) {
          extracted.contact_phone = digits;
          break;
        }
      }
    }

    // Nome: primeira linha com 2+ palavras que não seja data nem só números
    for (const line of lines) {
      const digits = line.replace(/\D/g, '');
      if (digits.length < 6 && line.split(' ').length >= 2 && /[a-zA-ZÀ-ú]/.test(line)) {
        extracted.name = line;
        break;
      }
    }
    console.log(`🔍 Extração fallback:`, JSON.stringify(extracted));
  }

  // Validar nome extraído — rejeitar se parecer uma frase, não um nome
  if (extracted.name) {
    const nameCandidate = extracted.name.trim();
    const wordCount = nameCandidate.split(/\s+/).length;
    const hasNonNameChars = /[!?.,;:(){}\[\]@#$%&*=+0-9]/.test(nameCandidate);
    const tooLong = nameCandidate.length > 60;
    const tooManyWords = wordCount > 6;
    const looksLikeSentence = /(que|como|pode|fazer|emita|valor|paguei|quero|preciso|gostaria|obrigad|bom dia|boa tarde|boa noite|ola|oi)/i.test(nameCandidate);
    
    if (hasNonNameChars || tooLong || tooManyWords || looksLikeSentence) {
      console.log(`⚠️ Nome extraído rejeitado (parece frase): "${nameCandidate}"`);
      extracted.name = null;
    }
  }

  // Merge com o que já temos no banco (coletas parciais anteriores)
  const updatedName         = extracted.name         || patient.name;
  const updatedBirthDate    = extracted.birth_date    || patient.birth_date;
  const updatedContactPhone = extracted.contact_phone || patient.contact_phone;

  // Salvar parcialmente mesmo que incompleto (para próximas mensagens)
  if (extracted.name || extracted.birth_date || extracted.contact_phone) {
    const { queries } = await import('./database.js');
    queries.updatePatient.run({
      id:        patient.id,
      name:      updatedName       || patient.name,
      email:     patient.email,
      specialty: patient.specialty,
      notes:     patient.notes,
    });
    // Salvar campos novos diretamente
    if (extracted.birth_date || extracted.contact_phone) {
      const db = (await import('./database.js')).default;
      db.prepare(`UPDATE patients SET birth_date = COALESCE(@birth_date, birth_date),
                  contact_phone = COALESCE(@contact_phone, contact_phone),
                  updated_at = datetime('now','localtime') WHERE id = @id`)
        .run({ id: patient.id, birth_date: extracted.birth_date, contact_phone: extracted.contact_phone });
    }
  }

  // Verificar quais campos ainda faltam
  const missingFields = [];
  if (!updatedName || updatedName === 'Novo Paciente') missingFields.push('*nome*');
  // Data de nascimento e telefone ser\u00e3o coletados na hora do agendamento

  if (missingFields.length === 0) {
    // Tentar buscar no CRM por nome (especialmente para pacientes LID)
    try {
      const { searchPatientByName } = await import("./crmApi.js");
      const crmResult = await searchPatientByName(updatedName);
      if (crmResult && crmResult.found && crmResult.patient) {
        const crmPat = crmResult.patient;
        console.log("CRM match by name: " + crmPat.name + " (id: " + crmPat.id + ")");
        const db = (await import("./database.js")).default;
        db.prepare("UPDATE patients SET birth_date = COALESCE(@bd, birth_date), contact_phone = COALESCE(@cp, contact_phone), registration_complete = 1, lgpd_consent = 1, updated_at = datetime(now,localtime) WHERE id = @id")
          .run({ id: patient.id, bd: crmPat.birthDate || null, cp: crmPat.phone ? crmPat.phone.replace(/\D/g, "") : null });
        const firstName = updatedName.split(" ")[0];
        const reply = "Ola, *" + firstName + "*! Te encontrei no nosso sistema. Como posso te ajudar? \u{1F60A}";
        saveMessage(patient.id, "assistant", reply);
        return reply;
      }
    } catch (err) {
      console.log("CRM name search error: " + err.message);
    }
    console.log(`📋 Dados coletados para ${updatedName} — aguardando consentimento LGPD`);
    const reply = lgpdConsentMessage(updatedName);
    saveMessage(patient.id, 'assistant', reply);
    return reply;
  }

  const reply = `N\u00e3o consegui identificar seu nome. Pode me dizer seu *nome completo*? 😊`;
  saveMessage(patient.id, 'assistant', reply);
  return reply;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detecta se o paciente está confirmando o consentimento LGPD.
 */
function isLgpdConfirmation(message) {
  const text = message.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^(sim|s|ok|concordo|aceito|autorizo|de acordo|confirmo|certo|claro|pode|tudo bem)$/.test(text)
    || /concordo|aceito|autorizo/.test(text);
}

/**
 * Detecta se o paciente está perguntando sobre horários disponíveis para agendar.
 * Quando true, Cláudia envia mensagem de espera e ativa o modo humano (Dr. Diego responde).
 */
function isAvailabilityQuestion(message) {
  const text = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // remove acentos

  // Não confundir com perguntas sobre horário de funcionamento da clínica
  if (/horario\s*de\s*(funcionamento|atendimento|abertura)/.test(text)) return false;

  return (
    /horario[s]?\s*(disponivel[s]?|livre[s]?|vago[s]?)/.test(text) ||  // "horário disponível/livre/vago"
    /disponivel[s]?\s*horario/.test(text) ||                             // "disponível horário"
    /tem\s+horario[s]?/.test(text) ||                                    // "tem horário"
    /quais?\s*(os\s+)?horario[s]?/.test(text) ||                        // "qual/quais horários"
    /proximo[s]?\s+horario[s]?/.test(text) ||                           // "próximo horário"
    /tem\s+vaga[s]?/.test(text) ||                                       // "tem vaga"
    /vaga[s]?\s*(disponivel[s]?|livre[s]?|aberta[s]?)/.test(text) ||    // "vaga disponível/livre"
    /quando\s+(tem|ha|posso|consigo|da)\s+(horario|agendar|marcar)/.test(text) || // "quando tem horário/posso agendar"
    /agenda\s+(disponivel|livre|aberta)/.test(text)                      // "agenda disponível/livre"
  );
}

/**
 * Verifica se a mensagem é um score de pesquisa de satisfação (1-5).
 */
function extractSurveyScore(message) {
  const trimmed = message.trim();
  if (/^[1-5]$/.test(trimmed)) return trimmed;

  // Também aceita formatos como "4/5", "nota 4", "nota: 4"
  const match = trimmed.match(/(?:nota[:\s]+)?([1-5])(?:\s*\/\s*5)?/i);
  return match ? match[1] : null;
}

